//! kenari plan quota — the data behind the settings card and the composer
//! ring.
//!
//! Two sources, cheapest first:
//!
//! - **Every chat reply.** A served reply on an unrestricted key carries
//!   `x-kenari-plan-remaining: week=0.99, month=1.00` — the fraction of each
//!   capped window that is LEFT, two decimals, as it stood before the request
//!   was charged. Seen live 2026-10-26. The adapters hand every reply's
//!   headers to [`record_reply`], so a chat keeps the fractions current at no
//!   cost. A reply says nothing about the reset clocks or the budgets, so it
//!   only ever updates a reading the endpoint already gave.
//! - **`GET /v1/account/quota`** (docs: `/en/docs/account-quota`): the plan
//!   name, every capped window with its ceiling, use and remainder in whole
//!   Rupiah plus `used_frac` and an RFC 3339 `resets_at`, the active coupon,
//!   and `alert_pct`, the account's own quota-alert threshold. Free to read,
//!   60 a minute per account. Asked when nothing recent is known.
//!
//! Both land in one per-key copy; a failed endpoint read falls back to that
//! copy rather than replacing numbers with an error.
//!
//! Who can read it: an unrestricted key of the account. A shared key answers
//! `403 shared_key_not_allowed`, a restricted key (model scope, spend or
//! token cap) `403 restricted_key_not_allowed`. Both are reported in words.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::Value;

use super::KENARI_API_BASE;
use crate::api::client::ProviderConfigSnapshot;

/// How long a known reading is good enough to answer without asking the
/// endpoint. Chats refresh the fractions on every reply; this bounds an idle one.
const FRESH_FOR_MS: i64 = 5 * 60 * 1000;

/// One capped window. `used_frac` is what is SPENT (0..1); the ring shows what
/// is left. Rupiah figures are whole Rupiah, as the endpoint rounds them.
#[derive(Debug, Clone, Serialize)]
pub struct KenariWindow {
    pub used_frac: f64,
    pub resets_in_secs: Option<i64>,
    pub resets_at_ms: Option<i64>,
    pub budget_rp: Option<i64>,
    pub used_rp: Option<i64>,
    pub remaining_rp: Option<i64>,
}

/// The active coupon, reported apart from the plan: an account can hold one
/// without a plan.
#[derive(Debug, Clone, Serialize)]
pub struct KenariCoupon {
    pub name: Option<String>,
    pub used_rp: Option<i64>,
    /// `None` when the coupon has no spending limit.
    pub remaining_rp: Option<i64>,
    pub expires_at_ms: Option<i64>,
    pub scope_models: Vec<String>,
}

/// The plan's headroom, which is the whole point of this module.
#[derive(Debug, Clone, Serialize)]
pub struct KenariUsage {
    pub plan_name: Option<String>,
    pub window_5h: Option<KenariWindow>,
    pub window_week: Option<KenariWindow>,
    pub window_month: Option<KenariWindow>,
    pub coupon: Option<KenariCoupon>,
    /// The account's quota-alert threshold: 50, 80 or 90.
    pub alert_pct: Option<i64>,
    /// A window has reached the account's own threshold. kenari's judgement
    /// (its `alert_pct`), not one Aurora invented.
    pub near_limit: bool,
    pub fetched_at_ms: i64,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn rfc3339_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn parse_window(raw: Option<&Value>, now_ms: i64) -> Option<KenariWindow> {
    let entry = raw?.as_object()?;
    let resets_at_ms = rfc3339_ms(entry.get("resets_at"));
    Some(KenariWindow {
        // Clamped: a meter drawn past its own track reads as a rendering bug
        // rather than as "over the limit".
        used_frac: entry
            .get("used_frac")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0),
        resets_in_secs: resets_at_ms.map(|at| ((at - now_ms) / 1000).max(0)),
        resets_at_ms,
        budget_rp: entry.get("budget_rp").and_then(Value::as_i64),
        used_rp: entry.get("used_rp").and_then(Value::as_i64),
        remaining_rp: entry.get("remaining_rp").and_then(Value::as_i64),
    })
}

fn parse_coupon(raw: Option<&Value>) -> Option<KenariCoupon> {
    let entry = raw?.as_object()?;
    Some(KenariCoupon {
        name: entry.get("name").and_then(Value::as_str).map(str::to_string),
        used_rp: entry.get("used_rp").and_then(Value::as_i64),
        remaining_rp: entry.get("remaining_rp").and_then(Value::as_i64),
        expires_at_ms: rfc3339_ms(entry.get("expires_at")),
        scope_models: entry
            .get("scope_models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn near_limit(windows: [&Option<KenariWindow>; 3], alert_pct: Option<i64>) -> bool {
    let Some(alert) = alert_pct else { return false };
    windows
        .into_iter()
        .flatten()
        .any(|w| w.used_frac * 100.0 >= alert as f64)
}

/// Map the endpoint's body into a reading. Public within the module tree for
/// tests.
pub(crate) fn parse_quota(root: &Value, now_ms: i64) -> KenariUsage {
    let plan = root.get("plan").filter(|v| !v.is_null());
    let windows = plan.and_then(|p| p.get("windows"));
    let window_5h = parse_window(windows.and_then(|w| w.get("five_hour")), now_ms);
    let window_week = parse_window(windows.and_then(|w| w.get("week")), now_ms);
    let window_month = parse_window(windows.and_then(|w| w.get("month")), now_ms);
    let alert_pct = root.get("alert_pct").and_then(Value::as_i64);
    KenariUsage {
        plan_name: plan
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        near_limit: near_limit([&window_5h, &window_week, &window_month], alert_pct),
        window_5h,
        window_week,
        window_month,
        coupon: parse_coupon(root.get("coupon").filter(|v| !v.is_null())),
        alert_pct,
        fetched_at_ms: now_ms,
    }
}

// ---------------------------------------------------------------------------
// Reply headers
// ---------------------------------------------------------------------------

/// `week=0.99, month=1.00` → the fraction LEFT per window key. Pure, for tests.
pub(crate) fn parse_plan_remaining(value: &str) -> Vec<(String, f64)> {
    value
        .split(',')
        .filter_map(|pair| {
            let (key, frac) = pair.trim().split_once('=')?;
            let frac = frac.trim().parse::<f64>().ok()?;
            Some((key.trim().to_string(), frac.clamp(0.0, 1.0)))
        })
        .collect()
}

/// Lay a reply's fractions over a known reading. Only windows the reading
/// already has are touched: a reply says nothing about clocks or budgets, so
/// it cannot stand in for the endpoint.
pub(crate) fn merge_remaining(mut known: KenariUsage, remaining: &[(String, f64)], now_ms: i64) -> KenariUsage {
    for (key, left) in remaining {
        let slot = match key.as_str() {
            "five_hour" => &mut known.window_5h,
            "week" => &mut known.window_week,
            "month" => &mut known.window_month,
            _ => continue,
        };
        if let Some(window) = slot {
            window.used_frac = (1.0 - left).clamp(0.0, 1.0);
            if let Some(at) = window.resets_at_ms {
                window.resets_in_secs = Some(((at - now_ms) / 1000).max(0));
            }
            if let Some(budget) = window.budget_rp {
                // The header carries two decimals, so budget × fraction is a
                // whole number of RP up to float noise (`1.0 - 0.99` is not
                // exactly 0.01; a ceiling made 300,000 × 0.01 into 3,001).
                let used = ((budget as f64) * window.used_frac).round() as i64;
                window.used_rp = Some(used);
                window.remaining_rp = Some((budget - used).max(0));
            }
        }
    }
    known.near_limit = near_limit([&known.window_5h, &known.window_week, &known.window_month], known.alert_pct);
    known.fetched_at_ms = now_ms;
    known
}

/// Note what a chat reply reported for the key that made it. Called by the
/// three generic adapters on every response; anything that is not kenari, or
/// a reply without the header, changes nothing.
pub fn record_reply(config: &ProviderConfigSnapshot, headers: &HeaderMap) {
    if !config.effective_provider_type().starts_with("kenari") || config.api_key.is_empty() {
        return;
    }
    let Some(value) = headers
        .get("x-kenari-plan-remaining")
        .and_then(|v| v.to_str().ok())
    else {
        return;
    };
    let remaining = parse_plan_remaining(value);
    if remaining.is_empty() {
        return;
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(known) = known_for(&config.api_key) {
        remember(&config.api_key, &merge_remaining(known, &remaining, now_ms));
    }
}

// ---------------------------------------------------------------------------
// Per-key copy
// ---------------------------------------------------------------------------

fn known() -> &'static Mutex<HashMap<String, KenariUsage>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, KenariUsage>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn known_for(api_key: &str) -> Option<KenariUsage> {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(api_key)
        .cloned()
}

fn remember(api_key: &str, usage: &KenariUsage) {
    known()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(api_key.to_string(), usage.clone());
}

/// Countdowns move with the clock; recompute them for a stored reading.
fn as_of(mut usage: KenariUsage, now_ms: i64) -> KenariUsage {
    for w in [&mut usage.window_5h, &mut usage.window_week, &mut usage.window_month]
        .into_iter()
        .flatten()
    {
        if let Some(at) = w.resets_at_ms {
            w.resets_in_secs = Some(((at - now_ms) / 1000).max(0));
        }
    }
    usage
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

/// How much of the plan is left for `api_key`: the last reading when recent,
/// the endpoint otherwise.
pub async fn fetch_usage(api_key: &str) -> Result<KenariUsage, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("Add your kenari API key to see plan quota.".to_string());
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cached = known_for(api_key);
    if let Some(usage) = cached.as_ref().filter(|u| now_ms - u.fetched_at_ms < FRESH_FOR_MS) {
        return Ok(as_of(usage.clone(), now_ms));
    }
    match fetch_quota(api_key).await {
        Ok(usage) => {
            remember(api_key, &usage);
            Ok(usage)
        }
        // An older reading beats an error in place of the numbers; the card
        // says how old it is.
        Err(err) => match cached {
            Some(usage) => {
                crate::logging::log_warn(
                    "kenari.usage",
                    &format!("quota read failed, showing the last known numbers: {err}"),
                );
                Ok(as_of(usage, now_ms))
            }
            None => Err(err),
        },
    }
}

async fn fetch_quota(api_key: &str) -> Result<KenariUsage, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| format!("Could not reach kenari: {err}"))?;
    let response = client
        .get(format!("{KENARI_API_BASE}/account/quota"))
        .bearer_auth(api_key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Could not reach kenari: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(refusal(status.as_u16(), &body));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|err| format!("kenari sent something unreadable: {err}"))?;
    Ok(parse_quota(&value, chrono::Utc::now().timestamp_millis()))
}

/// The endpoint's refusals, in words the card can show. Public within the
/// module tree for tests.
pub(crate) fn refusal(status: u16, body: &str) -> String {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    match (status, code.as_deref()) {
        (401, _) => "kenari refused the API key. Check the key under Connection.".to_string(),
        (403, Some("shared_key_not_allowed")) => {
            "This is a shared kenari key, and a shared key cannot read the owner's quota.".to_string()
        }
        (403, Some("restricted_key_not_allowed")) => {
            "This kenari key is restricted (a model scope, spend cap or token cap), so it cannot read the account's quota. Use an unrestricted key from the account.".to_string()
        }
        (429, _) => "kenari is rate limiting quota reads. Try again in a few seconds.".to_string(),
        _ => format!("kenari returned {status}: {}", body.trim().chars().take(160).collect::<String>()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The live answer on Alvan's Studio account, 2026-10-26, verbatim.
    fn studio() -> Value {
        json!({
            "alert_pct": 80,
            "coupon": null,
            "plan": {
                "name": "Studio",
                "windows": {
                    "month": {
                        "budget_rp": 1200000, "remaining_rp": 1197364,
                        "resets_at": "2026-11-24T02:21:39Z", "used_frac": 0.0022, "used_rp": 2636
                    },
                    "week": {
                        "budget_rp": 300000, "remaining_rp": 297364,
                        "resets_at": "2026-11-01T02:21:39Z", "used_frac": 0.0088, "used_rp": 2636
                    }
                }
            }
        })
    }

    #[test]
    fn parses_the_live_studio_answer() {
        // 2026-10-26T04:19:00Z
        let now_ms = 1_792_988_340_000;
        let usage = parse_quota(&studio(), now_ms);
        assert_eq!(usage.plan_name.as_deref(), Some("Studio"));
        assert!(usage.window_5h.is_none(), "no 5-hour cap on Studio");
        let week = usage.window_week.expect("week");
        assert!((week.used_frac - 0.0088).abs() < 1e-9);
        assert_eq!(week.budget_rp, Some(300_000));
        assert_eq!(week.remaining_rp, Some(297_364));
        // 2026-11-01T02:21:39Z
        assert_eq!(week.resets_at_ms, Some(1_793_499_699_000));
        assert_eq!(week.resets_in_secs, Some((1_793_499_699_000 - now_ms) / 1000));
        assert!(usage.window_month.is_some());
        assert!(usage.coupon.is_none());
        assert_eq!(usage.alert_pct, Some(80));
        assert!(!usage.near_limit);
        assert_eq!(usage.fetched_at_ms, now_ms);
    }

    #[test]
    fn no_plan_is_no_windows_not_full_ones() {
        let usage = parse_quota(&json!({ "plan": null, "coupon": null, "alert_pct": 80 }), 0);
        assert!(usage.plan_name.is_none());
        assert!(usage.window_week.is_none() && usage.window_month.is_none() && usage.window_5h.is_none());
    }

    #[test]
    fn near_limit_is_the_accounts_own_threshold() {
        let mut raw = studio();
        raw["plan"]["windows"]["week"]["used_frac"] = json!(0.81);
        assert!(parse_quota(&raw, 0).near_limit);
        raw["alert_pct"] = json!(90);
        assert!(!parse_quota(&raw, 0).near_limit);
    }

    #[test]
    fn a_coupon_is_read_with_its_models() {
        let mut raw = studio();
        raw["coupon"] = json!({
            "name": "Launch", "used_rp": 1000, "remaining_rp": null,
            "expires_at": "2026-12-01T00:00:00Z", "scope_models": ["glm-5.3", "deepseek-v4-pro"]
        });
        let coupon = parse_quota(&raw, 0).coupon.expect("coupon");
        assert_eq!(coupon.name.as_deref(), Some("Launch"));
        assert_eq!(coupon.remaining_rp, None, "no spending limit");
        assert_eq!(coupon.scope_models, vec!["glm-5.3", "deepseek-v4-pro"]);
        assert!(coupon.expires_at_ms.is_some());
    }

    /// The header one served reply carried, verbatim.
    #[test]
    fn a_reply_header_updates_the_fractions_and_nothing_else() {
        let remaining = parse_plan_remaining("week=0.99, month=1.00");
        assert_eq!(remaining, vec![("week".to_string(), 0.99), ("month".to_string(), 1.0)]);
        let known = parse_quota(&studio(), 1_000);
        let merged = merge_remaining(known, &remaining, 2_000);
        let week = merged.window_week.expect("week");
        assert!((week.used_frac - 0.01).abs() < 1e-9);
        assert_eq!(week.resets_at_ms, Some(1_793_499_699_000), "clock kept");
        assert_eq!(week.budget_rp, Some(300_000), "budget kept");
        assert_eq!(week.used_rp, Some(3_000), "use re-derived from the budget");
        assert_eq!(week.remaining_rp, Some(297_000));
        assert_eq!(merged.window_month.expect("month").used_frac, 0.0);
        assert_eq!(merged.fetched_at_ms, 2_000);
    }

    #[test]
    fn a_reply_cannot_invent_a_window() {
        let known = parse_quota(&studio(), 0);
        let merged = merge_remaining(known, &[("five_hour".to_string(), 0.5)], 0);
        assert!(merged.window_5h.is_none());
    }

    #[test]
    fn refusals_are_worded() {
        assert!(refusal(401, "invalid key").contains("refused the API key"));
        assert!(refusal(403, r#"{"error":{"code":"shared_key_not_allowed"}}"#).contains("shared"));
        assert!(refusal(403, r#"{"error":{"code":"restricted_key_not_allowed"}}"#).contains("restricted"));
        assert!(refusal(500, r#"{"error":{"code":"internal_error"}}"#).starts_with("kenari returned 500"));
    }
}
