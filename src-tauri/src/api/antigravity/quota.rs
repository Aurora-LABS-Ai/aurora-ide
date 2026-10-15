//! The account's quota, as Antigravity itself shows it.
//!
//! `retrieveUserQuotaSummary` answers with model GROUPS (Gemini Models; Claude
//! and GPT models), each holding one bucket per window. Measured 2026-10-12:
//! a Google AI Pro account has a `weekly` and a `5h` bucket in each group; a
//! free account has only `weekly`. Models in a group share its buckets, so
//! this, not the per-model `quotaInfo` in the model list (which on Pro tracks
//! the 5-hour window), is what the card and the ring draw.

use serde::Serialize;
use serde_json::Value;

use super::auth::{self, AntigravityAccess};
use super::{user_agent, API_BASE};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaBucket {
    /// `gemini-weekly`, `3p-5h`, …
    pub id: String,
    /// The backend's own label, e.g. "Five Hour Limit Remaining".
    pub label: String,
    /// `weekly`, `5h`, or whatever the backend adds next.
    pub window: String,
    /// 0–100 left.
    pub remaining_percent: f64,
    /// RFC 3339.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaGroup {
    /// "Gemini Models", "Claude and GPT models".
    pub name: String,
    /// "Models within this group: …".
    pub description: Option<String>,
    pub buckets: Vec<QuotaBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuota {
    pub groups: Vec<QuotaGroup>,
    /// The account's plan name ("Google AI Pro"), from the stored sign-in, so
    /// the ring can title the block without a second call.
    pub plan: Option<String>,
    pub fetched_at_ms: i64,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(super) fn parse_quota(body: &Value) -> AntigravityQuota {
    let groups = body
        .get("groups")
        .or_else(|| body.pointer("/quotaSummary/groups"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let buckets: Vec<QuotaBucket> = g
                .get("buckets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|b| {
                    // A disabled bucket is an exhausted one, not a missing one.
                    let remaining = if b.get("disabled").and_then(Value::as_bool) == Some(true) {
                        0.0
                    } else {
                        b.get("remainingFraction").and_then(Value::as_f64)?
                    };
                    Some(QuotaBucket {
                        id: text(b, "bucketId").unwrap_or_default(),
                        label: text(b, "displayName").unwrap_or_else(|| "Limit".to_string()),
                        window: text(b, "window").unwrap_or_default().to_ascii_lowercase(),
                        remaining_percent: (remaining * 100.0).clamp(0.0, 100.0),
                        resets_at: text(b, "resetTime"),
                    })
                })
                .collect();
            (!buckets.is_empty()).then(|| QuotaGroup {
                name: text(g, "displayName").unwrap_or_else(|| "Models".to_string()),
                description: text(g, "description"),
                buckets,
            })
        })
        .collect();
    AntigravityQuota {
        groups,
        plan: None,
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

pub(super) async fn fetch_with(access: &AntigravityAccess) -> Result<AntigravityQuota, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .post(format!("{API_BASE}:retrieveUserQuotaSummary"))
        .bearer_auth(&access.access_token)
        .header(reqwest::header::USER_AGENT, user_agent())
        .json(&serde_json::json!({ "project": access.project_id }))
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Antigravity: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail: String = body.chars().take(300).collect();
        return Err(format!("Antigravity answered HTTP {status}: {detail}"));
    }
    let json: Value =
        serde_json::from_str(&body).map_err(|err| format!("Unreadable Antigravity quota: {err}"))?;
    Ok(parse_quota(&json))
}

/// The main account's quota, titled with its plan.
pub async fn fetch_quota() -> Result<AntigravityQuota, String> {
    let mut quota = fetch_with(&auth::fresh_access().await?).await?;
    quota.plan = auth::status().ok().and_then(|s| s.tier_name.or(s.tier_id));
    Ok(quota)
}

/// One stored account's quota, without making it main.
pub async fn fetch_quota_for(id: &str) -> Result<AntigravityQuota, String> {
    fetch_with(&auth::fresh_access_for(id).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The Google AI Pro reply from 2026-10-12, trimmed.
    #[test]
    fn a_pro_account_has_weekly_and_five_hour_buckets_per_group() {
        let q = parse_quota(&json!({
            "groups": [
                { "displayName": "Gemini Models",
                  "description": "Models within this group: Gemini Flash, Gemini Pro",
                  "buckets": [
                    { "bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly",
                      "resetTime": "2026-10-17T21:16:59Z", "remainingFraction": 0.99591506 },
                    { "bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h",
                      "resetTime": "2026-10-12T12:10:26Z", "remainingFraction": 1 }
                  ] },
                { "displayName": "Claude and GPT models",
                  "buckets": [
                    { "bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "remainingFraction": 1 },
                    { "bucketId": "3p-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "disabled": true }
                  ] }
            ]
        }));
        assert_eq!(q.groups.len(), 2);
        assert_eq!(q.groups[0].name, "Gemini Models");
        assert_eq!(q.groups[0].buckets.len(), 2);
        assert!((q.groups[0].buckets[0].remaining_percent - 99.591506).abs() < 1e-6);
        assert_eq!(q.groups[0].buckets[1].window, "5h");
        assert_eq!(q.groups[1].buckets[1].remaining_percent, 0.0, "disabled means used up");
    }

    #[test]
    fn a_free_account_has_weekly_only_and_garbage_is_empty() {
        let q = parse_quota(&json!({ "groups": [ { "displayName": "Gemini Models", "buckets": [
            { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.97 } ] } ] }));
        assert_eq!(q.groups[0].buckets.len(), 1);
        assert_eq!(q.groups[0].buckets[0].label, "Limit");
        assert!(parse_quota(&json!({})).groups.is_empty());
        assert!(parse_quota(&json!({ "groups": [ { "buckets": [ { "window": "5h" } ] } ] })).groups.is_empty());
    }
}
