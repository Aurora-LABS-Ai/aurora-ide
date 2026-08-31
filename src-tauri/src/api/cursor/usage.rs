//! Cursor subscription usage — the data behind the settings card.
//!
//! Aurora bills a Cursor turn against the user's plan, so the one thing the
//! card must answer is *how much of that plan is left*. Nothing on the agent
//! wire carries it: `agent.v1` reports a single token counter per turn and
//! says nothing about the account.
//!
//! ## Written against a captured response, not a guess
//!
//! None of these endpoints is documented. The shape below was captured from a
//! live Pro+ account (see the ignored `prints_the_live_usage_payload` test) and
//! checked field-by-field against what Cursor's own Plan & Usage screen
//! displays, because the one published third-party mapping to hand had the
//! buckets wrong — it reads `autoPercentUsed`/`apiPercentUsed` as "Auto +
//! Composer" and "API", while the app now presents them as **Cursor Models**
//! and **Other Models**. Aurora uses the app's names: two names for one number
//! is a contradiction the user notices immediately, and they will have the
//! Cursor window open next to this card.
//!
//! ```json
//! { "billingCycleEnd": "1788484378000",          // a STRING, and millis
//!   "planUsage": {
//!     "limit": 7000, "includedSpend": 7000,       // cents
//!     "bonusSpend": 22845, "totalSpend": 29845,
//!     "autoPercentUsed": 15.66,                   // → "Cursor Models"
//!     "apiPercentUsed": 100,                      // → "Other Models"
//!     "totalPercentUsed": 22.78 },
//!   "spendLimitUsage": {                          // → "On-Demand"
//!     "individualUsed": 7046, "individualLimit": 7000 },
//!   "displayMessage": "You've hit your usage limit" }
//! ```
//!
//! ## Two endpoints, tried in order
//!
//! 1. `DashboardService/GetCurrentPeriodUsage` with a bearer token.
//! 2. The same payload from `cursor.com`, authenticated with a session cookie
//!    built from the token's own `sub` claim. Aurora's credentials come from
//!    the Cursor desktop install, so this is the shape most likely to be
//!    accepted for an IDE-imported session — it is load-bearing, not
//!    theoretical.
//!
//! `/api/usage/summary` is **not** tried: it answers `404 Route not found` on
//! the current API, so calling it would spend a round trip on every card load
//! to learn nothing. `/auth/usage` still exists but reports request counts with
//! `maxRequestUsage: null` on a modern plan — nothing meterable — so it is kept
//! only as a last resort for older accounts.
//!
//! Parsing stays defensive — every field optional, drift degrades the card
//! rather than failing the provider — for the same reason as
//! [`crate::api::codex::usage`]: an undocumented endpoint that changes shape
//! must never take a working provider down with it.

use serde::Serialize;
use serde_json::Value;

use super::auth;
use super::CURSOR_API_BASE;

/// How long one attempt may take. A settings card must not sit spinning on a
/// hung connection.
const USAGE_TIMEOUT_SECS: u64 = 12;

/// The dashboard host, a different origin from the API.
const CURSOR_DASHBOARD_BASE: &str = "https://cursor.com";

/// What one metered line measures.
///
/// The card draws money and quota differently — a quota bar reads as a
/// fraction of an allowance, a spend bar has to show the actual dollars,
/// including when they have gone past the ceiling.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CursorMeterKind {
    /// A share of the plan's included allowance.
    Quota,
    /// Money that will be billed on top of the subscription.
    Spend,
}

/// One metered line on the card.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageWindow {
    /// Cursor's own name for this bucket, so the card and the Cursor app agree.
    pub label: String,
    pub kind: CursorMeterKind,
    /// 0–100, clamped — a bar cannot draw past its end.
    pub used_percent: f64,
    /// Spend so far, in dollars. **Not** clamped: being over the limit is the
    /// single most important thing this card can tell someone, and rounding it
    /// down to the ceiling would understate a real bill.
    pub used_usd: Option<f64>,
    /// The ceiling this line is measured against, in dollars.
    pub limit_usd: Option<f64>,
}

/// Which endpoint answered.
///
/// Kept on the snapshot rather than logged and dropped: the sources do not all
/// measure the same thing, so a number is not interpretable without knowing
/// where it came from.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CursorUsageSource {
    PeriodUsage,
    Dashboard,
    AuthUsage,
}

/// Snapshot for the settings card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageSnapshot {
    /// Empty is a legitimate answer: connected, with nothing metered to report.
    /// The card says so rather than drawing empty bars.
    pub windows: Vec<CursorUsageWindow>,
    /// Share of the whole included allowance, which Cursor reports separately
    /// from the per-bucket figures and does **not** draw as a bar. Kept as a
    /// number, not a fourth meter, so the card matches the app.
    pub total_percent_used: Option<f64>,
    /// Free usage Cursor granted on top of the plan, in dollars. Their own UI
    /// hides this behind a tooltip; it is real money not spent and worth
    /// stating plainly.
    pub bonus_usd: Option<f64>,
    /// Cursor's own status sentence, when it sent one — e.g. *"You've hit your
    /// usage limit"*. Preferred over anything Aurora would compose: it is the
    /// account's own words about its own state.
    pub notice: Option<String>,
    /// End of the current billing period, unix millis.
    pub resets_at_ms: Option<i64>,
    pub source: CursorUsageSource,
    pub fetched_at_ms: i64,
}

/// Read the signed-in account's plan usage.
///
/// Returns `Err` only when every source failed — one endpoint being unavailable
/// for an account is the normal case this cascade absorbs.
pub async fn fetch_usage() -> Result<CursorUsageSnapshot, String> {
    let access = auth::fresh_access(false).await?;
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(USAGE_TIMEOUT_SECS))
        // Same reason as the streaming turn: the platform TLS backend on
        // Windows negotiates differently, and rustls behaves the same
        // everywhere.
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("build HTTP client: {err}"))?;

    // Failures are collected rather than returned, so an exhausted cascade
    // names every attempt instead of whichever happened to run last.
    let mut failures: Vec<String> = Vec::new();

    match period_usage(&http, &access).await {
        Ok(Some(snapshot)) => return Ok(snapshot),
        Ok(None) => failures.push("GetCurrentPeriodUsage: no plan usage in the reply".into()),
        Err(err) => failures.push(format!("GetCurrentPeriodUsage: {err}")),
    }
    match dashboard_usage(&http, &access).await {
        Ok(Some(snapshot)) => return Ok(snapshot),
        Ok(None) => failures.push("dashboard: no plan usage in the reply".into()),
        Err(err) => failures.push(format!("dashboard: {err}")),
    }
    match auth_usage(&http, &access).await {
        Ok(Some(snapshot)) => return Ok(snapshot),
        Ok(None) => failures.push("/auth/usage: nothing metered".into()),
        Err(err) => failures.push(format!("/auth/usage: {err}")),
    }

    Err(format!(
        "Cursor reported no plan usage. Tried three endpoints — {}",
        failures.join("; ")
    ))
}

// ── The sources ──────────────────────────────────────────────────────────────

async fn period_usage(
    http: &reqwest::Client,
    access: &str,
) -> Result<Option<CursorUsageSnapshot>, String> {
    // Connect-RPC accepts JSON as readily as protobuf, and `cursor-proto`
    // vendors only the `agent.v1` schema — JSON avoids generating a message
    // type for a request whose body is empty.
    let value = json_call(
        http.post(format!(
            "{CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
        ))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .body("{}"),
        access,
    )
    .await?;

    Ok(parse_plan_usage(&value, CursorUsageSource::PeriodUsage))
}

async fn dashboard_usage(
    http: &reqwest::Client,
    access: &str,
) -> Result<Option<CursorUsageSnapshot>, String> {
    // The dashboard authenticates with a WorkOS session cookie rather than a
    // bearer, and that cookie is `<userId>::<token>`. The id is the token's own
    // `sub` claim, so nothing extra has to be stored to build it.
    let Some(user_id) = jwt_subject(access) else {
        return Err("the access token carries no account id".into());
    };

    let response = http
        .post(format!(
            "{CURSOR_DASHBOARD_BASE}/api/dashboard/get-current-period-usage"
        ))
        .header(
            "Cookie",
            format!("WorkosCursorSessionToken={user_id}::{access}"),
        )
        .header("Origin", CURSOR_DASHBOARD_BASE)
        .header("Referer", format!("{CURSOR_DASHBOARD_BASE}/dashboard"))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;

    let status = response.status();
    // A redirect is a sign-out, not a routing problem: the dashboard bounces
    // an unauthenticated request to the login page.
    if status.is_redirection() {
        return Err("the Cursor session has expired — sign in again".into());
    }
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            body.chars().take(160).collect::<String>()
        ));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|err| format!("reply was not JSON ({err})"))?;

    Ok(parse_plan_usage(&value, CursorUsageSource::Dashboard))
}

async fn auth_usage(
    http: &reqwest::Client,
    access: &str,
) -> Result<Option<CursorUsageSnapshot>, String> {
    let value = json_call(http.get(format!("{CURSOR_API_BASE}/auth/usage")), access).await?;

    // Request counts per model bucket. On a current plan every ceiling comes
    // back null, which `read_request_bucket` reports as a miss rather than as
    // a zero — a 0-of-0 meter states something the account never said.
    let bucket = value
        .get("gpt-4")
        .and_then(read_request_bucket)
        .or_else(|| {
            value.as_object()?.iter().find_map(|(key, candidate)| {
                if key == "startOfMonth" || key == "billingCycleStart" {
                    return None;
                }
                read_request_bucket(candidate)
            })
        });
    let Some((used, limit)) = bucket else {
        return Ok(None);
    };

    Ok(Some(CursorUsageSnapshot {
        windows: vec![CursorUsageWindow {
            label: "Premium requests".into(),
            kind: CursorMeterKind::Quota,
            used_percent: clamp_percent(used as f64 / limit as f64 * 100.0),
            used_usd: None,
            limit_usd: None,
        }],
        total_percent_used: None,
        bonus_usd: None,
        notice: None,
        // This endpoint reports the period's START. The reset is a month later,
        // and "resets in −20 days" is worse than saying nothing.
        resets_at_ms: None,
        source: CursorUsageSource::AuthUsage,
        fetched_at_ms: now_ms(),
    }))
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/// Read the `planUsage` + `spendLimitUsage` shape shared by the Connect
/// endpoint and the dashboard.
///
/// Public within the module tree for tests.
pub(crate) fn parse_plan_usage(
    root: &Value,
    source: CursorUsageSource,
) -> Option<CursorUsageSnapshot> {
    let plan = root.get("planUsage").filter(|value| value.is_object());
    let spend = root
        .get("spendLimitUsage")
        .filter(|value| value.is_object());
    // Either half alone is still a usable card; neither means this reply was
    // not a usage payload, and the cascade should move on rather than draw
    // zeroes.
    if plan.is_none() && spend.is_none() {
        return None;
    }

    let mut windows = Vec::new();
    let included_usd = plan
        .and_then(|plan| number(plan.get("limit")).or_else(|| number(plan.get("includedSpend"))))
        .filter(|limit| *limit > 0.0)
        .map(cents_to_usd);

    // The two included-allowance buckets, under the names Cursor's own Plan &
    // Usage screen gives them. Each is added only when the account actually
    // reported it — deriving a 0% bar from an absent field draws a control
    // asserting something nobody said.
    for (key, label) in [
        ("autoPercentUsed", "Cursor Models"),
        ("apiPercentUsed", "Other Models"),
    ] {
        let Some(percent) = plan.and_then(|plan| number(plan.get(key))) else {
            continue;
        };
        let percent = clamp_percent(percent);
        windows.push(CursorUsageWindow {
            label: label.into(),
            kind: CursorMeterKind::Quota,
            used_percent: percent,
            // These are shares of the one included allowance; that ceiling is
            // the only figure they are expressed against.
            used_usd: included_usd.map(|limit| round_cents(limit * percent / 100.0)),
            limit_usd: included_usd,
        });
    }

    // On-demand is a separate section in Cursor's UI and a separate object on
    // the wire — money billed on top of the subscription, not a share of it.
    if let Some(spend) = spend {
        let used = number(spend.get("individualUsed")).or_else(|| number(spend.get("totalSpend")));
        let limit = number(spend.get("individualLimit"));
        if let (Some(used), Some(limit)) = (used, limit) {
            windows.push(CursorUsageWindow {
                label: "On-Demand".into(),
                kind: CursorMeterKind::Spend,
                used_percent: if limit > 0.0 {
                    clamp_percent(used / limit * 100.0)
                } else {
                    0.0
                },
                used_usd: Some(cents_to_usd(used)),
                limit_usd: Some(cents_to_usd(limit)),
            });
        }
    }

    if windows.is_empty() {
        return None;
    }

    Some(CursorUsageSnapshot {
        windows,
        total_percent_used: plan
            .and_then(|plan| number(plan.get("totalPercentUsed")))
            .map(clamp_percent),
        // Only when Cursor says there is some left to talk about; a spent
        // bonus is not a feature to advertise.
        bonus_usd: plan
            .and_then(|plan| number(plan.get("bonusSpend")))
            .filter(|bonus| *bonus > 0.0)
            .map(cents_to_usd),
        notice: string(root.get("displayMessage")),
        resets_at_ms: millis(root.get("billingCycleEnd")),
        source,
        fetched_at_ms: now_ms(),
    })
}

/// `numRequests` / `maxRequestUsage` out of one model bucket, if it carries a
/// real ceiling.
fn read_request_bucket(bucket: &Value) -> Option<(i64, i64)> {
    let used = number(bucket.get("numRequests")).or_else(|| number(bucket.get("used")))?;
    let limit = number(bucket.get("maxRequestUsage"))
        .or_else(|| number(bucket.get("limit")))
        .or_else(|| number(bucket.get("maxRequests")))?;
    (limit > 0.0).then_some((used as i64, limit as i64))
}

// ── Small shared helpers ─────────────────────────────────────────────────────

/// Send a bearer-authenticated request and parse the reply as JSON.
async fn json_call(request: reqwest::RequestBuilder, access: &str) -> Result<Value, String> {
    let response = request
        .bearer_auth(access)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            body.chars().take(160).collect::<String>()
        ));
    }
    // An HTML body is the signed-out web app, not a payload. Saying so points
    // at the session; "expected value at line 1" points at a parser bug that
    // does not exist.
    if body.trim_start().starts_with('<') {
        return Err("answered with a web page, which means the session is not valid here".into());
    }
    serde_json::from_str(&body).map_err(|err| format!("reply was not JSON ({err})"))
}

/// The `sub` claim out of a JWT, without verifying it.
///
/// Verification would be pointless: the token came from Cursor and is going
/// straight back to Cursor, the only party that can judge it. This reads the
/// one id needed to shape a cookie.
fn jwt_subject(token: &str) -> Option<String> {
    use base64::Engine as _;

    let mut parts = token.split('.');
    let (_, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if signature.is_empty() || parts.next().is_some() {
        return None;
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    string(value.get("sub"))
}

/// A JSON number, whether it arrived as a number or as a numeric string.
///
/// Not defensive padding: this payload really does quote some of its numbers —
/// `billingCycleEnd` is `"1788484378000"` while `limit` is `7000`.
fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|number| number.is_finite())
}

fn string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A timestamp in unix millis, tolerating seconds.
fn millis(value: Option<&Value>) -> Option<i64> {
    let raw = number(value)?;
    if raw <= 0.0 {
        return None;
    }
    // Below this a value is too small to be a plausible millisecond timestamp
    // (it would land in 1970) and is therefore seconds. Read the wrong way it
    // renders as a reset that already happened.
    const SECONDS_CEILING: f64 = 100_000_000_000.0;
    Some(if raw < SECONDS_CEILING {
        (raw * 1000.0) as i64
    } else {
        raw as i64
    })
}

fn cents_to_usd(cents: f64) -> f64 {
    round_cents(cents / 100.0)
}

fn round_cents(usd: f64) -> f64 {
    (usd * 100.0).round() / 100.0
}

fn clamp_percent(percent: f64) -> f64 {
    percent.clamp(0.0, 100.0)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The payload captured from a live Pro+ account on 2026-08-26, verbatim
    /// apart from the model list. Every assertion below is checked against what
    /// Cursor's own Plan & Usage screen showed at the same moment.
    fn live_payload() -> Value {
        json!({
            "billingCycleStart": "1785805978000",
            "billingCycleEnd": "1788484378000",
            "planUsage": {
                "totalSpend": 29845,
                "includedSpend": 7000,
                "bonusSpend": 22845,
                "limit": 7000,
                "remainingBonus": false,
                "autoPercentUsed": 15.664166666666668,
                "apiPercentUsed": 100,
                "totalPercentUsed": 22.782442748091604
            },
            "spendLimitUsage": {
                "totalSpend": 7046,
                "individualLimit": 7000,
                "individualUsed": 7046,
                "limitType": "user"
            },
            "displayMessage": "You've hit your usage limit",
            "enabled": true
        })
    }

    #[test]
    fn the_meters_match_what_the_cursor_app_shows() {
        let snapshot =
            parse_plan_usage(&live_payload(), CursorUsageSource::PeriodUsage).expect("a snapshot");

        let labels: Vec<&str> = snapshot.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Cursor Models", "Other Models", "On-Demand"]);

        // "Cursor Models · 16% used"
        assert!((snapshot.windows[0].used_percent - 15.664).abs() < 0.01);
        // "Other Models · 100% used"
        assert_eq!(snapshot.windows[1].used_percent, 100.0);
        // "On-Demand · $70.46 / $70"
        assert_eq!(snapshot.windows[2].used_usd, Some(70.46));
        assert_eq!(snapshot.windows[2].limit_usd, Some(70.0));
        // "You've used 23% of your included total usage"
        assert!((snapshot.total_percent_used.unwrap() - 22.78).abs() < 0.01);
    }

    #[test]
    fn spending_past_the_limit_is_reported_at_full_value_not_clamped_to_it() {
        // $70.46 against a $70 ceiling. The bar cannot draw past its end, but
        // the dollars must stay true — the overage is the whole reason someone
        // opens this card, and rounding it down understates a real bill.
        let snapshot =
            parse_plan_usage(&live_payload(), CursorUsageSource::PeriodUsage).expect("a snapshot");
        let on_demand = &snapshot.windows[2];

        assert_eq!(on_demand.used_percent, 100.0, "the bar clamps");
        assert_eq!(on_demand.used_usd, Some(70.46), "the number does not");
        assert!(on_demand.used_usd > on_demand.limit_usd);
    }

    #[test]
    fn cursors_own_words_are_carried_rather_than_reworded() {
        let snapshot =
            parse_plan_usage(&live_payload(), CursorUsageSource::PeriodUsage).expect("a snapshot");
        assert_eq!(
            snapshot.notice.as_deref(),
            Some("You've hit your usage limit")
        );
    }

    #[test]
    fn the_quoted_reset_timestamp_is_read_as_a_number() {
        // `billingCycleEnd` arrives as a STRING while its neighbours are
        // numbers. Read strictly it vanishes, and the card silently loses its
        // reset date.
        let snapshot =
            parse_plan_usage(&live_payload(), CursorUsageSource::PeriodUsage).expect("a snapshot");
        assert_eq!(snapshot.resets_at_ms, Some(1_788_484_378_000));
    }

    #[test]
    fn granted_bonus_usage_is_surfaced_rather_than_left_in_a_tooltip() {
        let snapshot =
            parse_plan_usage(&live_payload(), CursorUsageSource::PeriodUsage).expect("a snapshot");
        assert_eq!(snapshot.bonus_usd, Some(228.45));

        // Nothing granted means nothing to say.
        let none = parse_plan_usage(
            &json!({ "planUsage": { "limit": 7000, "autoPercentUsed": 1, "bonusSpend": 0 } }),
            CursorUsageSource::PeriodUsage,
        )
        .expect("a snapshot");
        assert_eq!(none.bonus_usd, None);
    }

    #[test]
    fn a_bucket_the_account_did_not_report_is_left_out_rather_than_drawn_at_zero() {
        let snapshot = parse_plan_usage(
            &json!({ "planUsage": { "limit": 7000, "autoPercentUsed": 20 } }),
            CursorUsageSource::PeriodUsage,
        )
        .expect("a snapshot");

        let labels: Vec<&str> = snapshot.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Cursor Models"]);
    }

    #[test]
    fn a_reported_zero_is_still_drawn() {
        // Absent and zero are different facts: "you have used none of this"
        // is worth a bar, "the account never mentioned this" is not.
        let snapshot = parse_plan_usage(
            &json!({ "planUsage": { "limit": 7000, "apiPercentUsed": 0 } }),
            CursorUsageSource::PeriodUsage,
        )
        .expect("a snapshot");

        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].used_percent, 0.0);
    }

    #[test]
    fn a_reply_that_is_not_a_usage_payload_is_a_miss_so_the_cascade_moves_on() {
        assert!(parse_plan_usage(&json!({}), CursorUsageSource::PeriodUsage).is_none());
        assert!(parse_plan_usage(
            &json!({ "planUsage": {}, "spendLimitUsage": {} }),
            CursorUsageSource::PeriodUsage
        )
        .is_none());
    }

    #[test]
    fn the_account_id_comes_out_of_the_tokens_own_claims() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"user_123","email":"a@b.c"}"#);
        assert_eq!(
            jwt_subject(&format!("header.{payload}.signature")),
            Some("user_123".to_string())
        );
        // An opaque token is a miss, not a panic — the cascade simply skips
        // the one source that needs a cookie.
        assert_eq!(jwt_subject("not-a-jwt"), None);
        assert_eq!(jwt_subject("only.two"), None);
        assert_eq!(jwt_subject(""), None);
    }

    /// Print what the live account actually returns.
    ///
    /// These field names are documented nowhere. This is how the shape above
    /// was captured, and it is how to re-check it when Cursor changes its plan
    /// structure — which it has already done once, leaving the one published
    /// third-party mapping describing buckets the app no longer shows.
    ///
    /// ```text
    /// cargo test --lib api::cursor::usage -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "reads the developer's live Cursor account"]
    async fn prints_the_live_usage_payload() {
        let access = auth::fresh_access(false)
            .await
            .expect("a signed-in account");
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .expect("client");

        for (name, request) in [
            (
                "GetCurrentPeriodUsage",
                http.post(format!(
                    "{CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
                ))
                .header("content-type", "application/json")
                .header("connect-protocol-version", "1")
                .body("{}"),
            ),
            (
                "/auth/usage",
                http.get(format!("{CURSOR_API_BASE}/auth/usage")),
            ),
        ] {
            match json_call(request, &access).await {
                Ok(value) => println!(
                    "\n===== {name} =====\n{}",
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                ),
                Err(err) => println!("\n===== {name} =====\n(failed) {err}"),
            }
        }

        println!(
            "\n===== parsed =====\n{}",
            serde_json::to_string_pretty(&fetch_usage().await).unwrap_or_default()
        );
    }
}
