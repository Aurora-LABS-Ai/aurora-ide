//! The account's model list and how much of each model's quota is left.
//!
//! `fetchAvailableModels` answers with every model the backend knows about,
//! internal ones included (`chat_*`, `tab_*` completion models with no display
//! name, image and commit-message helpers). What Antigravity's own agent
//! picker offers is `agentModelSorts[*].groups[*].modelIds`, in that order;
//! that list is what Aurora offers too. Anything else would put models in the
//! picker that the backend treats as internal.
//!
//! Quota is per model, as `quotaInfo {remainingFraction, resetTime}`. The
//! backend also attaches a notice to some models (`tagTitle` /
//! `tagDescription`), for example that a free plan loses Claude access on a
//! date. Those are passed through for the card to show.

use serde::Serialize;
use serde_json::Value;

use super::auth::{self, AntigravityAccess};
use super::{user_agent, API_BASE};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityModel {
    pub id: String,
    pub label: String,
    /// Input window in tokens (`maxTokens`).
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub supports_images: bool,
    pub supports_thinking: bool,
    /// `google`, `anthropic`, `openai`, … from `modelProvider`.
    pub vendor: Option<String>,
    /// 0–100, how much of this model's quota is left. `None` when unreported.
    pub remaining_percent: Option<f64>,
    /// RFC 3339; when the quota refills.
    pub resets_at: Option<String>,
    /// The backend's own notice on this model, e.g. "Leaving Soon".
    pub notice_title: Option<String>,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCatalogue {
    pub models: Vec<AntigravityModel>,
    /// The model Antigravity selects by default.
    pub default_model_id: Option<String>,
    pub fetched_at_ms: i64,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<u32> {
    v.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

/// `MODEL_PROVIDER_ANTHROPIC` → `anthropic`.
fn vendor_of(v: &Value) -> Option<String> {
    let raw = text(v, "modelProvider")?;
    let name = raw.strip_prefix("MODEL_PROVIDER_").unwrap_or(&raw);
    Some(name.to_ascii_lowercase())
}

pub(super) fn parse_catalogue(body: &Value) -> AntigravityCatalogue {
    let all = body.get("models").and_then(Value::as_object);
    let mut ids: Vec<String> = Vec::new();
    for sort in body
        .get("agentModelSorts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for group in sort.get("groups").and_then(Value::as_array).into_iter().flatten() {
            for id in group.get("modelIds").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = id.as_str() {
                    if !ids.iter().any(|seen| seen == id) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }
    // An account the backend sent no picker order for: every model with a
    // display name, minus the image and internal helpers.
    if ids.is_empty() {
        if let Some(all) = all {
            let image_ids: Vec<&str> = body
                .get("imageGenerationModelIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            ids = all
                .iter()
                .filter(|(id, m)| m.get("displayName").is_some() && !image_ids.contains(&id.as_str()))
                .map(|(id, _)| id.clone())
                .collect();
        }
    }

    let models = ids
        .into_iter()
        .filter_map(|id| {
            let m = all?.get(&id)?;
            let quota = m.get("quotaInfo");
            Some(AntigravityModel {
                label: text(m, "displayName").unwrap_or_else(|| id.clone()),
                context_window: number(m, "maxTokens"),
                max_output_tokens: number(m, "maxOutputTokens"),
                supports_images: m.get("supportsImages").and_then(Value::as_bool) == Some(true),
                supports_thinking: m.get("supportsThinking").and_then(Value::as_bool) == Some(true),
                vendor: vendor_of(m),
                remaining_percent: quota
                    .and_then(|q| q.get("remainingFraction"))
                    .and_then(Value::as_f64)
                    .map(|f| (f * 100.0).clamp(0.0, 100.0))
                    // A quota object with no fraction means none is left.
                    .or_else(|| quota.filter(|q| q.get("resetTime").is_some()).map(|_| 0.0)),
                resets_at: quota.and_then(|q| text(q, "resetTime")),
                notice_title: text(m, "tagTitle"),
                notice: text(m, "tagDescription"),
                id,
            })
        })
        .collect();

    AntigravityCatalogue {
        models,
        default_model_id: text(body, "defaultAgentModelId"),
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

pub(super) async fn fetch_with(access: &AntigravityAccess) -> Result<AntigravityCatalogue, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .post(format!("{API_BASE}:fetchAvailableModels"))
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
    let json: Value = serde_json::from_str(&body)
        .map_err(|err| format!("Unreadable Antigravity model list: {err}"))?;
    Ok(parse_catalogue(&json))
}

/// The main account's models.
pub async fn fetch_catalogue() -> Result<AntigravityCatalogue, String> {
    fetch_with(&auth::fresh_access().await?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Trimmed from the 2026-10-12 reply on a free account.
    fn sample() -> Value {
        json!({
            "models": {
                "gemini-3.8-flash-high": {
                    "displayName": "Gemini 3.8 Flash (High)", "supportsImages": true,
                    "supportsThinking": true, "maxTokens": 1048576, "maxOutputTokens": 65535,
                    "quotaInfo": { "remainingFraction": 0.5, "resetTime": "2026-10-19T05:44:37Z" },
                    "modelProvider": "MODEL_PROVIDER_GOOGLE"
                },
                "claude-sonnet-4-6": {
                    "displayName": "Claude Sonnet 4.6 (Thinking)", "supportsImages": true,
                    "supportsThinking": true, "maxTokens": 250000, "maxOutputTokens": 64000,
                    "quotaInfo": { "resetTime": "2026-10-19T05:44:54Z" },
                    "modelProvider": "MODEL_PROVIDER_ANTHROPIC",
                    "tagTitle": "Notice", "tagDescription": "Third-party model access ends November 2, 2026."
                },
                "chat_20706": { "maxTokens": 16000, "quotaInfo": { "remainingFraction": 1 } },
                "gemini-3.1-flash-image": { "displayName": "Gemini 3.1 Flash Image" }
            },
            "defaultAgentModelId": "gemini-3.8-flash-high",
            "agentModelSorts": [{ "displayName": "Recommended", "groups": [
                { "modelIds": ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gone-model"] }
            ] }],
            "imageGenerationModelIds": ["gemini-3.1-flash-image"]
        })
    }

    #[test]
    fn the_picker_order_decides_what_is_offered() {
        let cat = parse_catalogue(&sample());
        let ids: Vec<&str> = cat.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gemini-3.8-flash-high", "claude-sonnet-4-6"], "internal, image and unknown ids left out");
        assert_eq!(cat.default_model_id.as_deref(), Some("gemini-3.8-flash-high"));
        let flash = &cat.models[0];
        assert_eq!(flash.label, "Gemini 3.8 Flash (High)");
        assert_eq!(flash.context_window, Some(1_048_576));
        assert_eq!(flash.max_output_tokens, Some(65_535));
        assert_eq!(flash.remaining_percent, Some(50.0));
        assert_eq!(flash.vendor.as_deref(), Some("google"));
    }

    #[test]
    fn a_quota_with_no_fraction_left_is_empty_and_notices_pass_through() {
        let cat = parse_catalogue(&sample());
        let claude = &cat.models[1];
        assert_eq!(claude.remaining_percent, Some(0.0));
        assert_eq!(claude.vendor.as_deref(), Some("anthropic"));
        assert_eq!(claude.notice_title.as_deref(), Some("Notice"));
        assert!(claude.notice.as_deref().unwrap().contains("November 2"));
    }

    #[test]
    fn without_a_picker_order_every_named_non_image_model_is_offered() {
        let mut body = sample();
        body.as_object_mut().unwrap().remove("agentModelSorts");
        let mut ids: Vec<String> = parse_catalogue(&body).models.into_iter().map(|m| m.id).collect();
        ids.sort();
        assert_eq!(ids, ["claude-sonnet-4-6", "gemini-3.8-flash-high"]);
    }
}
