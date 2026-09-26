//! The models the main Claude account can use.
//!
//! A Claude Code row has no API key, so the generic lister (which sends
//! `x-api-key`) is refused with "x-api-key header is required". This asks
//! the same `GET /v1/models` with the account's sign-in token instead, with
//! the headers every other request on this provider carries. Claude Code
//! 2.1.282 lists `/v1/models?limit=1000` for its own model discovery.
//!
//! Not verified live: whether the endpoint accepts a subscription token. If
//! it does not, the error says so and models are still added by id.

use serde::Deserialize;

use super::auth;
use super::{CLAUDE_API_BASE, CLAUDE_CODE_USER_AGENT, OAUTH_BETA};

const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Deserialize)]
struct ModelsPage {
    #[serde(default)]
    data: Vec<WireModel>,
}

#[derive(Debug, Deserialize)]
struct WireModel {
    id: Option<String>,
    display_name: Option<String>,
}

/// `(id, display name)` for every model the account's token can see.
pub async fn list_models() -> Result<Vec<(String, Option<String>)>, String> {
    let access = auth::fresh_access().await?;
    let response = reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(format!("{CLAUDE_API_BASE}/v1/models?limit=1000"))
        .bearer_auth(&access.access_token)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", OAUTH_BETA)
        .header("x-app", "cli")
        .header(reqwest::header::USER_AGENT, CLAUDE_CODE_USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|err| format!("Could not reach Claude's model list: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let head: String = body.trim().chars().take(200).collect();
        return Err(if matches!(status.as_u16(), 401 | 403) {
            format!(
                "Claude did not let this sign-in read the model list ({status}). Add models by id instead. {head}"
            )
        } else {
            format!("Claude's model list answered {status}. {head}")
        });
    }
    parse(&body)
}

fn parse(body: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let page: ModelsPage = serde_json::from_str(body)
        .map_err(|err| format!("Claude's model list was not in the expected shape: {err}"))?;
    let models: Vec<(String, Option<String>)> = page
        .data
        .into_iter()
        .filter_map(|m| {
            let id = m.id?.trim().to_string();
            (!id.is_empty()).then(|| {
                let label = m
                    .display_name
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty() && *d != id);
                (id, label)
            })
        })
        .collect();
    if models.is_empty() {
        return Err("Claude's model list came back empty for this account.".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_messages_api_model_page() {
        let models = parse(
            r#"{"data":[
                {"type":"model","id":"claude-fable-5-1","display_name":"Claude Fable 5.1"},
                {"type":"model","id":"claude-sonnet-5"},
                {"type":"model","display_name":"no id"}
            ],"has_more":false}"#,
        )
        .expect("parses");
        assert_eq!(
            models,
            vec![
                ("claude-fable-5-1".to_string(), Some("Claude Fable 5.1".to_string())),
                ("claude-sonnet-5".to_string(), None),
            ]
        );
        assert!(parse(r#"{"data":[]}"#).is_err());
    }
}
