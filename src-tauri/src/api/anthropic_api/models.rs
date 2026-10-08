//! The models an Anthropic API key can use.
//!
//! The generic lister asks `GET /v1/models` with no page size, and Anthropic
//! answers 20 rows plus `has_more`, so the newest models arrived and older
//! ones the key can still use were cut off. This asks for the whole list in
//! one page (`limit` caps at 1000) and follows `last_id` if Anthropic ever
//! pages anyway.

use serde::Deserialize;

use super::ANTHROPIC_VERSION;

const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Anthropic's page cap for `/v1/models`.
const PAGE_LIMIT: u32 = 1000;

/// A guard against a server that keeps saying `has_more`. Ten full pages is
/// ten thousand models.
const MAX_PAGES: usize = 10;

#[derive(Debug, Deserialize)]
struct ModelsPage {
    #[serde(default)]
    data: Vec<WireModel>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    last_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireModel {
    id: Option<String>,
    display_name: Option<String>,
}

/// `(id, display name)` for every model the key can see.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Paste an Anthropic API key first. Create one at console.anthropic.com.".into());
    }
    // Same normalisation as the generic lister: a pasted `…/v1/messages`
    // still finds `…/v1/models`.
    let url = crate::commands::provider_models::models_url(base_url);
    let client = reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not start the request: {e}"))?;

    let mut models: Vec<(String, Option<String>)> = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut request = client
            .get(&url)
            .query(&[("limit", PAGE_LIMIT.to_string())])
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(cursor) = &after {
            request = request.query(&[("after_id", cursor)]);
        }
        let response = request.send().await.map_err(|err| {
            if err.is_timeout() {
                format!("Anthropic's model list did not answer within {}s.", LIST_TIMEOUT.as_secs())
            } else {
                format!("Could not reach Anthropic's model list: {err}")
            }
        })?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &body));
        }
        let page = parse(&body)?;
        for model in page.data {
            if let Some(id) = model.id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty()) {
                let label = model
                    .display_name
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty() && *l != id);
                models.push((id, label));
            }
        }
        match (page.has_more, page.last_id) {
            (true, Some(last)) => after = Some(last),
            _ => break,
        }
    }

    if models.is_empty() {
        return Err("Anthropic answered with an empty model list. Add models by id instead.".into());
    }
    Ok(models)
}

fn parse(body: &str) -> Result<ModelsPage, String> {
    serde_json::from_str(body)
        .map_err(|_| "Anthropic answered, but not with a model list Aurora could read.".to_string())
}

/// A failed list, as a sentence naming the next action.
fn explain(status: reqwest::StatusCode, body: &str) -> String {
    // Anthropic's error envelope: `{"type":"error","error":{"type":…,"message":…}}`.
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default();
    let said = if message.is_empty() {
        String::new()
    } else {
        format!(" Anthropic said: {message}")
    };
    match status.as_u16() {
        401 | 403 => format!(
            "Anthropic rejected the API key ({status}). Check the key on this row.{said}"
        ),
        429 => format!("Rate-limited by Anthropic ({status}). Try again shortly.{said}"),
        _ => format!("Anthropic's model list answered {status}.{said}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_reads_ids_labels_and_the_cursor() {
        let page = parse(
            r#"{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5",
                "max_input_tokens":1000000,"max_tokens":128000}],
               "has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}"#,
        )
        .expect("parses");
        assert_eq!(page.data[0].id.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(page.data[0].display_name.as_deref(), Some("Claude Opus 5.5"));
        assert!(page.has_more);
        assert_eq!(page.last_id.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn an_auth_failure_names_the_key_and_carries_anthropics_reason() {
        let text = explain(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        );
        assert!(text.contains("rejected the API key"), "{text}");
        assert!(text.contains("invalid x-api-key"), "{text}");
    }
}
