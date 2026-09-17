//! Token Plan quota — how much of the subscription is left.
//!
//! `GET https://www.minimax.io/v1/token_plan/remains`, authenticated with the
//! same subscription key that serves chat. **This endpoint is undocumented.**
//! MiniMax's own pages say only that usage "is shown as a usage bar in the
//! console"; the route came from a third-party reference and was then confirmed
//! against the live account (HTTP 200, real numbers) before this was written.
//!
//! Because it is undocumented it can change without notice, so every field is
//! optional and a shape drift degrades the card rather than erroring the
//! provider. A plan section that quietly disappears is a smaller failure than a
//! provider that stops working.
//!
//! ## The response, as measured
//!
//! ```json
//! {
//!   "model_remains": [
//!     {
//!       "model_name": "general",
//!       "start_time": 1788966000000, "end_time": 1788984000000,
//!       "remains_time": 15477074,
//!       "current_interval_total_count": 0, "current_interval_usage_count": 0,
//!       "current_interval_remaining_percent": 100, "current_interval_status": 1,
//!       "weekly_start_time": 1788739200000, "weekly_end_time": 1789344000000,
//!       "weekly_remains_time": 375477074,
//!       "current_weekly_total_count": 0, "current_weekly_usage_count": 0,
//!       "current_weekly_remaining_percent": 100, "current_weekly_status": 1
//!     },
//!     { "model_name": "video", "...": "..." }
//!   ],
//!   "base_resp": { "status_code": 0, "status_msg": "success" }
//! }
//! ```
//!
//! Two things about that payload decide how it is read here.
//!
//! **The percentages are what to draw, not the counts.** On a live Max plan the
//! `general` row reported `total_count: 0` and `usage_count: 0` alongside
//! `remaining_percent: 100`, while the `video` row carried real counts (3 and
//! 21). Text quota is metered as a share; the counts belong to countable
//! resources. Rendering `0 of 0` would say the plan was exhausted when it is
//! untouched.
//!
//! **`remains_time` is a DURATION in milliseconds, not an instant.** It sat at
//! 15,477,074 against window bounds seventeen days apart, so reading it as a
//! timestamp puts the reset in 1970.
//!
//! `base_resp.status_code` is MiniMax's own success flag and is `0` on success
//! — a non-zero code arrives with HTTP 200, so the status line alone cannot be
//! trusted to mean the read worked.

use serde::{Deserialize, Serialize};

use super::MINIMAX_ACCOUNT_BASE;

/// One metered resource, over both of the plan's windows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimaxQuota {
    /// MiniMax's own name for the bucket: `general` is text, `video` is video.
    pub model_name: String,
    /// 0–100 REMAINING in the rolling 5-hour window. Not what is spent.
    pub interval_remaining_percent: f64,
    /// Milliseconds until the 5-hour window rolls over.
    pub interval_resets_in_ms: Option<i64>,
    /// 0–100 remaining this week.
    pub weekly_remaining_percent: f64,
    /// Milliseconds until the weekly window rolls over.
    pub weekly_resets_in_ms: Option<i64>,
    /// Countable allowance, where the resource is counted at all. `general`
    /// reports zeroes here on a live plan; `video` reports real numbers.
    pub interval_total_count: Option<i64>,
    pub interval_usage_count: Option<i64>,
    pub weekly_total_count: Option<i64>,
    pub weekly_usage_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MinimaxUsageSnapshot {
    /// Every bucket the account reports, in the order it reported them.
    pub quotas: Vec<MinimaxQuota>,
    pub fetched_at_ms: i64,
}

impl MinimaxUsageSnapshot {
    /// The text bucket, which is the only one a coding agent spends.
    ///
    /// `#[cfg(test)]` because the whole snapshot is serialized to the frontend
    /// and the bucket is chosen there, so nothing in the Rust half calls this —
    /// only the tests below, which the `--lib` target cannot see. That made it
    /// the one `dead_code` warning on every `cargo run`, and a warning that
    /// fires on a correct accessor is a warning people stop reading.
    #[cfg(test)]
    #[must_use]
    pub fn general(&self) -> Option<&MinimaxQuota> {
        self.quotas
            .iter()
            .find(|q| q.model_name.eq_ignore_ascii_case("general"))
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────
// Every field optional: this endpoint is undocumented and a drift must degrade
// the card, never fail the read.

#[derive(Debug, Deserialize)]
struct WireRoot {
    #[serde(default)]
    model_remains: Vec<WireQuota>,
    #[serde(default)]
    base_resp: Option<WireBaseResp>,
}

#[derive(Debug, Deserialize)]
struct WireBaseResp {
    #[serde(default)]
    status_code: Option<i64>,
    #[serde(default)]
    status_msg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireQuota {
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    current_interval_remaining_percent: Option<f64>,
    #[serde(default)]
    current_weekly_remaining_percent: Option<f64>,
    #[serde(default)]
    remains_time: Option<i64>,
    #[serde(default)]
    weekly_remains_time: Option<i64>,
    #[serde(default)]
    current_interval_total_count: Option<i64>,
    #[serde(default)]
    current_interval_usage_count: Option<i64>,
    #[serde(default)]
    current_weekly_total_count: Option<i64>,
    #[serde(default)]
    current_weekly_usage_count: Option<i64>,
}

/// Read the plan's remaining quota.
///
/// Errors carry a sentence a person can act on, because they surface on the
/// provider card: a key that cannot read the account is a different problem
/// from an account with no subscription.
pub async fn fetch_usage(api_key: &str) -> Result<MinimaxUsageSnapshot, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("No MiniMax key set. Paste one in Settings › Providers › MiniMax.".into());
    }

    let response = reqwest::Client::new()
        .get(format!("{MINIMAX_ACCOUNT_BASE}/v1/token_plan/remains"))
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Could not reach MiniMax: {err}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "MiniMax refused the usage read (HTTP {status}): {}",
            body.chars().take(160).collect::<String>()
        ));
    }

    parse_usage(&body)
}

/// Map the raw body into a snapshot. Separate from the request so the shape can
/// be tested against a payload captured from the live account.
pub(crate) fn parse_usage(body: &str) -> Result<MinimaxUsageSnapshot, String> {
    let root: WireRoot = serde_json::from_str(body)
        .map_err(|err| format!("MiniMax sent something that is not usage JSON: {err}"))?;

    // A non-zero `status_code` arrives with HTTP 200, so this is the only place
    // a refusal actually shows up. Reported rather than swallowed: an empty
    // plan section over a failed read reads as "no limits", which is the
    // opposite of the truth on a plan that stops serving when it runs out.
    if let Some(resp) = &root.base_resp {
        if resp.status_code.unwrap_or(0) != 0 {
            let msg = resp.status_msg.as_deref().unwrap_or("no reason given");
            return Err(format!("MiniMax refused the usage read: {msg}"));
        }
    }

    let quotas = root
        .model_remains
        .into_iter()
        .filter_map(|q| {
            let model_name = q.model_name?;
            Some(MinimaxQuota {
                model_name,
                interval_remaining_percent: clamp_percent(q.current_interval_remaining_percent),
                interval_resets_in_ms: positive(q.remains_time),
                weekly_remaining_percent: clamp_percent(q.current_weekly_remaining_percent),
                weekly_resets_in_ms: positive(q.weekly_remains_time),
                interval_total_count: q.current_interval_total_count,
                interval_usage_count: q.current_interval_usage_count,
                weekly_total_count: q.current_weekly_total_count,
                weekly_usage_count: q.current_weekly_usage_count,
            })
        })
        .collect();

    Ok(MinimaxUsageSnapshot {
        quotas,
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

/// Missing reads as FULL, not as empty. A percentage nobody reported is not a
/// spent plan, and drawing it as one would put a red bar over an untouched
/// subscription.
fn clamp_percent(value: Option<f64>) -> f64 {
    value.unwrap_or(100.0).clamp(0.0, 100.0)
}

/// A countdown that has run out or arrived negative says nothing useful.
fn positive(value: Option<i64>) -> Option<i64> {
    value.filter(|ms| *ms > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from a live Token Plan Max account, 2026-09-09.
    const LIVE: &str = r#"{"model_remains":[{"start_time":1788966000000,"end_time":1788984000000,
"remains_time":15477074,"current_interval_total_count":0,"current_interval_usage_count":0,
"model_name":"general","current_weekly_total_count":0,"current_weekly_usage_count":0,
"weekly_start_time":1788739200000,"weekly_end_time":1789344000000,"weekly_remains_time":375477074,
"current_interval_status":1,"current_interval_remaining_percent":100,"current_weekly_status":1,
"current_weekly_remaining_percent":100},{"start_time":1788912000000,"end_time":1788998400000,
"remains_time":29877074,"current_interval_total_count":3,"current_interval_usage_count":0,
"model_name":"video","current_weekly_total_count":21,"current_weekly_usage_count":0,
"weekly_start_time":1788739200000,"weekly_end_time":1789344000000,"weekly_remains_time":375477074,
"current_interval_status":1,"current_interval_remaining_percent":100,"current_weekly_status":1,
"current_weekly_remaining_percent":100}],"base_resp":{"status_code":0,"status_msg":"success"}}"#;

    #[test]
    fn reads_the_live_payload() {
        let snap = parse_usage(LIVE).expect("the real thing parses");
        assert_eq!(snap.quotas.len(), 2);
        let general = snap.general().expect("a general bucket");
        assert_eq!(general.interval_remaining_percent, 100.0);
        assert_eq!(general.weekly_remaining_percent, 100.0);
        // A DURATION, not an instant — roughly 4h18m, which fits a 5-hour
        // window. Read as a timestamp it would land in 1970.
        assert_eq!(general.interval_resets_in_ms, Some(15_477_074));
        assert_eq!(general.weekly_resets_in_ms, Some(375_477_074));
    }

    /// Text quota is metered as a share and reports zero counts, while video
    /// carries real ones. Drawing "0 of 0" for text would report an untouched
    /// plan as spent.
    #[test]
    fn text_reports_no_counts_while_video_does() {
        let snap = parse_usage(LIVE).expect("parsed");
        let general = snap.general().expect("general");
        assert_eq!(general.interval_total_count, Some(0));
        let video = snap
            .quotas
            .iter()
            .find(|q| q.model_name == "video")
            .expect("video");
        assert_eq!(video.interval_total_count, Some(3));
        assert_eq!(video.weekly_total_count, Some(21));
    }

    /// A non-zero `base_resp.status_code` rides in on an HTTP 200, so it is the
    /// only place a refusal is visible.
    #[test]
    fn a_refusal_inside_a_200_is_still_a_refusal() {
        let err = parse_usage(r#"{"base_resp":{"status_code":1004,"status_msg":"not authorized"}}"#)
            .expect_err("must not read as an empty plan");
        assert!(err.contains("not authorized"), "{err}");
    }

    #[test]
    fn an_unreported_percentage_reads_as_full_not_spent() {
        let snap = parse_usage(r#"{"model_remains":[{"model_name":"general"}]}"#).expect("parsed");
        let general = snap.general().expect("general");
        assert_eq!(general.interval_remaining_percent, 100.0);
        assert_eq!(general.weekly_remaining_percent, 100.0);
        assert_eq!(general.interval_resets_in_ms, None);
    }

    /// Undocumented endpoint: a shape drift must degrade, never error.
    #[test]
    fn an_unknown_shape_degrades_rather_than_failing() {
        let snap = parse_usage(r#"{"model_remains":[],"something_new":42}"#).expect("parsed");
        assert!(snap.quotas.is_empty());
        assert!(snap.general().is_none());
        // A row with no name cannot be drawn or labelled, so it is dropped.
        let unnamed = parse_usage(r#"{"model_remains":[{"remains_time":5}]}"#).expect("parsed");
        assert!(unnamed.quotas.is_empty());
    }

    #[test]
    fn a_body_that_is_not_json_says_so() {
        assert!(parse_usage("<html>nope</html>").is_err());
    }
}
