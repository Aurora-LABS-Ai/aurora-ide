//! The models this ChatGPT account can use through Codex.
//!
//! A Codex row has no API key, so the generic `GET <base>/models` lister
//! cannot ask on its behalf. Codex CLI asks its own backend instead:
//! `codex-api/src/endpoint/models.rs` in the installed 0.155.0 binary,
//! answering a `ModelsResponse { models: [ModelInfo] }` whose entries carry
//! `slug` (the wire id), `display_name` and `visibility`. The backend decides
//! which models to offer from `client_version`, so an old version string
//! would hide newer models.

use serde::Deserialize;

use super::auth;
use super::{CODEX_BACKEND_BASE, CODEX_ORIGINATOR, CODEX_USER_AGENT};

/// Sent as `client_version`. Matched to the Codex CLI the listing was read
/// from; bump it when a newer Codex offers models this one is not shown.
const CODEX_CLIENT_VERSION: &str = "0.155.0";

const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    models: Vec<WireModel>,
}

#[derive(Debug, Deserialize)]
struct WireModel {
    slug: Option<String>,
    display_name: Option<String>,
    /// `list` shows in Codex's picker; `hide` / `none` do not.
    visibility: Option<String>,
}

/// `(id, display name)` for every model Codex would show in its picker.
pub async fn list_models() -> Result<Vec<(String, Option<String>)>, String> {
    let access = auth::fresh_access(false).await?;
    let mut request = reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(format!(
            "{CODEX_BACKEND_BASE}/codex/models?client_version={CODEX_CLIENT_VERSION}"
        ))
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
        .map_err(|err| format!("Could not reach the Codex model list: {err}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let head: String = body.trim().chars().take(200).collect();
        return Err(if matches!(status.as_u16(), 401 | 403) {
            format!("ChatGPT refused the sign-in ({status}). Sign in to Codex again. {head}")
        } else {
            format!("The Codex model list answered {status}. {head}")
        });
    }
    parse(&body)
}

fn parse(body: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let parsed: ModelsResponse = serde_json::from_str(body)
        .map_err(|err| format!("The Codex model list was not in the expected shape: {err}"))?;
    let models: Vec<(String, Option<String>)> = parsed
        .models
        .into_iter()
        .filter(|m| !matches!(m.visibility.as_deref(), Some("hide") | Some("none")))
        .filter_map(|m| {
            let id = m.slug?.trim().to_string();
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
        return Err("The Codex model list came back empty for this account.".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_what_codex_would_show_and_skips_hidden_models() {
        let models = parse(
            r#"{"models":[
                {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","supported_in_api":true},
                {"slug":"gpt-5.5-codex","display_name":"gpt-5.5-codex"},
                {"slug":"internal-eval","display_name":"x","visibility":"hide"},
                {"display_name":"no slug"}
            ]}"#,
        )
        .expect("parses");
        assert_eq!(
            models,
            vec![
                ("gpt-5.5".to_string(), Some("GPT-5.5".to_string())),
                ("gpt-5.5-codex".to_string(), None),
            ]
        );
    }

    #[test]
    fn an_empty_or_foreign_body_is_an_error_not_an_empty_list() {
        assert!(parse(r#"{"models":[]}"#).is_err());
        assert!(parse("<html>").is_err());
    }
}
