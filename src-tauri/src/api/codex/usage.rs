//! Codex subscription usage — the data behind the settings card and the
//! composer ring.
//!
//! Two sources, cheapest first:
//!
//! - **Every model reply.** The ChatGPT backend answers each
//!   `/codex/responses` call with `x-codex-*` headers: both windows
//!   (`-primary-` / `-secondary-` `used-percent`, `window-minutes`,
//!   `reset-after-seconds`, `reset-at`), `x-codex-plan-type` and the three
//!   `x-codex-credits-*` fields. Seen on the wire 2026-10-26 with
//!   `scripts/probe-codex-headers.py`. The adapter hands them to
//!   [`record_headers`], so a chat keeps the numbers current at no cost.
//! - **`GET https://chatgpt.com/backend-api/wham/usage`**, the endpoint
//!   Codex CLI's `/status` reads: a `rate_limits` payload with the same two
//!   windows plus `credits` and `plan_type`. Asked only when nothing recent
//!   is known.
//!
//! Both land in one per-account copy; a failed endpoint read falls back to
//! that copy rather than replacing numbers with an error.
//!
//! Parsing is deliberately defensive (`serde_json::Value`, every field
//! optional): the endpoint is undocumented, so a shape drift should
//! degrade the card, never error the provider.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::Value;

use super::auth;
use super::{CODEX_BACKEND_BASE, CODEX_ORIGINATOR, CODEX_USER_AGENT};

/// How long a known reading is good enough to answer without asking the
/// endpoint. Chats refresh it on every reply; this only bounds an idle one.
const FRESH_FOR_MS: i64 = 5 * 60 * 1000;

/// The key for a sign-in whose token carries no account id.
const UNKEYED_ACCOUNT: &str = "main";

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

// ---------------------------------------------------------------------------
// Per-account copy
// ---------------------------------------------------------------------------

fn known() -> &'static Mutex<HashMap<String, CodexUsageSnapshot>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, CodexUsageSnapshot>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn known_for(account_id: &str) -> Option<CodexUsageSnapshot> {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(account_id)
        .cloned()
}

fn remember(account_id: &str, snapshot: &CodexUsageSnapshot) {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(account_id.to_string(), snapshot.clone());
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn header_num(headers: &HeaderMap, name: &str) -> Option<f64> {
    header_str(headers, name).and_then(|v| v.parse::<f64>().ok())
}

/// The backend writes Python booleans (`True` / `False`) into these headers.
fn header_bool(headers: &HeaderMap, name: &str) -> Option<bool> {
    match header_str(headers, name)?.to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// One window from a reply's headers. `used-percent` is required; the rest
/// is filled from whichever of the two reset fields came, so a countdown
/// and an absolute time are both always known when either is.
fn header_window(headers: &HeaderMap, which: &str, now_ms: i64) -> Option<CodexUsageWindow> {
    let used_percent = header_num(headers, &format!("x-codex-{which}-used-percent"))?;
    let window_minutes = header_num(headers, &format!("x-codex-{which}-window-minutes"))
        .filter(|m| *m >= 0.0)
        .map(|m| m as u64);
    let reset_after = header_num(headers, &format!("x-codex-{which}-reset-after-seconds")).map(|s| s as i64);
    let reset_at_ms = header_num(headers, &format!("x-codex-{which}-reset-at")).map(|s| (s * 1000.0) as i64);
    Some(CodexUsageWindow {
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_in_seconds: reset_after.or_else(|| reset_at_ms.map(|at| ((at - now_ms) / 1000).max(0))),
        resets_at_ms: reset_at_ms.or_else(|| reset_after.map(|s| now_ms + s * 1000)),
    })
}

fn header_credits(headers: &HeaderMap) -> Option<CodexCredits> {
    let has_credits = header_bool(headers, "x-codex-credits-has-credits");
    let unlimited = header_bool(headers, "x-codex-credits-unlimited");
    let balance = header_str(headers, "x-codex-credits-balance").map(str::to_string);
    if has_credits.is_none() && unlimited.is_none() && balance.is_none() {
        return None;
    }
    Some(CodexCredits {
        has_credits: has_credits.unwrap_or(false),
        unlimited: unlimited.unwrap_or(false),
        balance,
    })
}

/// The reading a reply's headers carry, laid over what is already known about
/// the account. `None` when the headers say nothing (no window at all).
pub(crate) fn merge_headers(
    previous: Option<CodexUsageSnapshot>,
    headers: &HeaderMap,
    now_ms: i64,
) -> Option<CodexUsageSnapshot> {
    let primary = header_window(headers, "primary", now_ms);
    let secondary = header_window(headers, "secondary", now_ms);
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    let mut snapshot = previous.unwrap_or(CodexUsageSnapshot {
        plan_type: None,
        limit_reached: false,
        primary: None,
        secondary: None,
        credits: None,
        fetched_at_ms: now_ms,
    });
    if primary.is_some() {
        snapshot.primary = primary;
    }
    if secondary.is_some() {
        snapshot.secondary = secondary;
    }
    if let Some(plan) = header_str(headers, "x-codex-plan-type") {
        snapshot.plan_type = Some(plan.to_string());
    }
    if let Some(credits) = header_credits(headers) {
        snapshot.credits = Some(credits);
    }
    // A reply that was served is a window that is not spent; a refused one
    // is marked by the adapter from its body, not from here.
    snapshot.limit_reached = snapshot
        .primary
        .iter()
        .chain(snapshot.secondary.iter())
        .any(|w| w.used_percent >= 100.0);
    snapshot.fetched_at_ms = now_ms;
    Some(snapshot)
}

/// Note the usage a model reply reported for the account. Called by the
/// adapter on every response, successful or refused; a response without the
/// headers changes nothing.
pub fn record_headers(account_id: Option<&str>, headers: &HeaderMap) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let id = account_id.unwrap_or(UNKEYED_ACCOUNT);
    if let Some(snapshot) = merge_headers(known_for(id), headers, now_ms) {
        remember(id, &snapshot);
    }
}

/// Countdowns move with the clock; recompute them for a stored reading.
fn as_of(mut snapshot: CodexUsageSnapshot, now_ms: i64) -> CodexUsageSnapshot {
    for w in [&mut snapshot.primary, &mut snapshot.secondary].into_iter().flatten() {
        if let Some(at) = w.resets_at_ms {
            w.resets_in_seconds = Some(((at - now_ms) / 1000).max(0));
        }
    }
    snapshot
}

/// Fetch the current usage snapshot for the account serving requests: the
/// last reply's reading when recent, the endpoint otherwise.
pub async fn fetch_usage() -> Result<CodexUsageSnapshot, String> {
    let access = auth::fresh_access(false).await?;
    usage_with(&access).await
}

/// The same snapshot for one named account, whether or not it is the active
/// one — this is what lets the switcher show every account's headroom at once.
pub async fn fetch_usage_for(account_id: &str) -> Result<CodexUsageSnapshot, String> {
    let access = auth::fresh_access_for(account_id, false).await?;
    usage_with(&access).await
}

async fn usage_with(access: &auth::CodexAccess) -> Result<CodexUsageSnapshot, String> {
    let id = access.account_id.as_deref().unwrap_or(UNKEYED_ACCOUNT);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cached = known_for(id);
    if let Some(snapshot) = cached.as_ref().filter(|s| now_ms - s.fetched_at_ms < FRESH_FOR_MS) {
        return Ok(as_of(snapshot.clone(), now_ms));
    }
    match fetch_usage_with(access).await {
        Ok(snapshot) => {
            remember(id, &snapshot);
            Ok(snapshot)
        }
        // An older reading beats an error in place of the numbers; the card
        // says how old it is.
        Err(err) => match cached {
            Some(snapshot) => {
                crate::logging::log_warn(
                    "codex.usage",
                    &format!("usage read failed, showing the last known numbers: {err}"),
                );
                Ok(as_of(snapshot, now_ms))
            }
            None => Err(err),
        },
    }
}

async fn fetch_usage_with(access: &auth::CodexAccess) -> Result<CodexUsageSnapshot, String> {
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

    let value: Value =
        serde_json::from_str(&body).map_err(|err| format!("Usage response was not JSON: {err}"))?;
    Ok(parse_usage(&value))
}

/// Map the raw payload into the card snapshot. Public within the module
/// tree for tests.
pub(crate) fn parse_usage(root: &Value) -> CodexUsageSnapshot {
    // The endpoint wraps its rate-limit payload in `rate_limits`, but not
    // every field lives inside that wrapper — this response is undocumented
    // and has been seen carrying `credits` and `plan_type` as siblings of it
    // rather than children.
    //
    // So each field is looked up in the wrapper FIRST and in the root
    // SECOND, instead of swapping wholesale to the wrapper the moment it
    // exists. That swap is what made a plan section render its windows and
    // stay silent about credits: the windows were inside, the balance was
    // outside, and once the wrapper won there was nowhere left to look. An
    // account whose window is spent and whose work is now paid for out of
    // credits is exactly when that silence costs the most.
    let wrapper = root.get("rate_limits").filter(|v| !v.is_null());
    let pick = |key: &str| -> Option<&Value> {
        wrapper
            .and_then(|w| w.get(key))
            .or_else(|| root.get(key))
            .filter(|v| !v.is_null())
    };
    let rate_limit = pick("rate_limit");

    CodexUsageSnapshot {
        plan_type: pick("plan_type")
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
        credits: pick("credits").map(|c| CodexCredits {
            has_credits: c
                .get("has_credits")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            unlimited: c.get("unlimited").and_then(Value::as_bool).unwrap_or(false),
            balance: c.get("balance").and_then(Value::as_str).map(str::to_string),
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
        assert_eq!(
            snap.secondary.expect("secondary").window_minutes,
            Some(10080)
        );
        let credits = snap.credits.expect("credits");
        assert!(credits.has_credits);
        assert_eq!(credits.balance.as_deref(), Some("12.5"));
    }

    /// The shape that made the context ring draw a spent window and say
    /// nothing about the credits paying for the work: the rate limits are
    /// wrapped, the balance is a sibling of the wrapper. Reading every field
    /// out of the wrapper once it exists loses both `credits` and `plan_type`.
    #[test]
    fn finds_credits_left_outside_the_rate_limits_wrapper() {
        let raw = json!({
            "plan_type": "pro",
            "credits": { "has_credits": true, "unlimited": false, "balance": "3850.0000001" },
            "rate_limits": {
                "rate_limit": {
                    "limit_reached": true,
                    "secondary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 2_592_000,
                        "reset_after_seconds": 2_253_600
                    }
                }
            }
        });
        let snap = parse_usage(&raw);
        assert_eq!(snap.plan_type.as_deref(), Some("pro"));
        assert!(snap.limit_reached);
        assert_eq!(snap.secondary.expect("secondary").used_percent, 100.0);
        let credits = snap.credits.expect("credits outside the wrapper");
        assert!(credits.has_credits);
        assert_eq!(credits.balance.as_deref(), Some("3850.0000001"));
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

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                reqwest::header::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    /// The exact headers one served reply carried on 2026-10-26
    /// (`scripts/probe-codex-headers.py`, a Plus account on gpt-6.1-sol).
    #[test]
    fn reply_headers_become_a_reading() {
        let now_ms = 1_792_988_364_000;
        let h = headers(&[
            ("x-codex-active-limit", "premium"),
            ("x-codex-plan-type", "plus"),
            ("x-codex-primary-used-percent", "0"),
            ("x-codex-secondary-used-percent", "5"),
            ("x-codex-primary-window-minutes", "300"),
            ("x-codex-primary-over-secondary-limit-percent", "0"),
            ("x-codex-secondary-window-minutes", "10080"),
            ("x-codex-primary-reset-after-seconds", "13640"),
            ("x-codex-secondary-reset-after-seconds", "562119"),
            ("x-codex-primary-reset-at", "1793002002"),
            ("x-codex-secondary-reset-at", "1793550481"),
            ("x-codex-credits-has-credits", "False"),
            ("x-codex-credits-balance", "0"),
            ("x-codex-credits-unlimited", "False"),
        ]);
        let snap = merge_headers(None, &h, now_ms).expect("a reading");
        assert_eq!(snap.plan_type.as_deref(), Some("plus"));
        let primary = snap.primary.expect("primary");
        assert_eq!(primary.used_percent, 0.0);
        assert_eq!(primary.window_minutes, Some(300));
        assert_eq!(primary.resets_in_seconds, Some(13640));
        assert_eq!(primary.resets_at_ms, Some(1_793_002_002_000));
        let secondary = snap.secondary.expect("secondary");
        assert_eq!(secondary.used_percent, 5.0);
        assert_eq!(secondary.window_minutes, Some(10080));
        let credits = snap.credits.expect("credits");
        assert!(!credits.has_credits);
        assert!(!credits.unlimited);
        assert_eq!(credits.balance.as_deref(), Some("0"));
        assert!(!snap.limit_reached);
        assert_eq!(snap.fetched_at_ms, now_ms);
    }

    /// A reply with no windows says nothing; one with a single window keeps
    /// the other from the previous reading.
    #[test]
    fn headers_lay_over_the_known_reading() {
        assert!(merge_headers(None, &headers(&[("x-codex-plan-type", "plus")]), 0).is_none());
        let first = merge_headers(
            None,
            &headers(&[
                ("x-codex-primary-used-percent", "40"),
                ("x-codex-secondary-used-percent", "70"),
                ("x-codex-credits-balance", "12"),
            ]),
            1_000,
        )
        .unwrap();
        let second = merge_headers(
            Some(first),
            &headers(&[("x-codex-primary-used-percent", "100"), ("x-codex-primary-reset-after-seconds", "60")]),
            2_000,
        )
        .unwrap();
        assert_eq!(second.primary.as_ref().unwrap().used_percent, 100.0);
        assert_eq!(second.primary.as_ref().unwrap().resets_at_ms, Some(62_000));
        assert_eq!(second.secondary.as_ref().unwrap().used_percent, 70.0);
        assert_eq!(second.credits.as_ref().unwrap().balance.as_deref(), Some("12"));
        assert!(second.limit_reached);
        assert_eq!(second.fetched_at_ms, 2_000);
    }
}
