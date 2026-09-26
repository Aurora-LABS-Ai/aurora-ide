//! Ask a provider what models it has.
//!
//! Adding a model to a custom provider used to mean typing its id by hand, one
//! at a time, from memory or from a browser tab — while nearly every provider
//! Aurora talks to publishes the list at `GET <base>/models`. The built-in
//! rows that DO have a lister (Modal, Command Code, OpenCode, kenari, the local
//! runtimes) each wrote their own, so an ordinary API-key row was the only kind
//! left doing it manually.
//!
//! This is the generic one. It answers with ids and nothing else: what a model
//! COSTS and what it can do still comes from models.dev on the way in, because
//! a `/models` listing carries neither, and inventing that metadata from an id
//! is how a context window ends up wrong in a way nobody notices until a turn
//! is rejected.
//!
//! ## Why Rust rather than a `fetch` in the settings pane
//!
//! Two reasons, both practical. The key would otherwise cross into the webview
//! and ride in a browser request, and most of these hosts answer a webview's
//! preflight with nothing at all — the same CORS wall that put every other
//! provider call on this side.
//!
//! ## What it does NOT do
//!
//! It does not add anything. It reads, and hands the list back for a person to
//! choose from. A provider that returns three hundred models must not put three
//! hundred rows in someone's settings because they pressed a button once.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// How long a provider gets to answer. Longer than the local probe (3s) —
/// these are real hosts over the internet — and short enough that a wrong base
/// URL fails while the person is still looking at the button.
const LIST_TIMEOUT_MS: u64 = 15_000;

/// One model as the provider described it. Ids only, by design — see the
/// module docs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    /// The exact string to send as `model`. Never re-cased or normalized: this
    /// is the wire value, and a provider that says `GLM-5.3` does not answer
    /// to `glm-5.3`.
    pub id: String,
    /// A human label when the provider offers one (Anthropic's `display_name`,
    /// LM Studio's). `None` is normal and the id stands in.
    pub display_name: Option<String>,
}

/// The listing shapes seen in the wild, tried in order.
#[derive(Deserialize)]
#[serde(untagged)]
enum ModelsBody {
    /// OpenAI and Anthropic both use this: `{"data": [...]}`.
    Wrapped { data: Vec<Value> },
    /// Ollama's native shape: `{"models": [...]}`.
    Ollama { models: Vec<Value> },
    /// A bare array, which a few small gateways return.
    Bare(Vec<Value>),
}

impl ModelsBody {
    fn rows(self) -> Vec<Value> {
        match self {
            Self::Wrapped { data } => data,
            Self::Ollama { models } => models,
            Self::Bare(rows) => rows,
        }
    }
}

/// Pull an id out of one row, whatever the provider called the field.
///
/// A row may also be a bare string — that is what a couple of gateways return
/// inside `data`, and reading it costs one line.
fn row_to_model(row: &Value) -> Option<DiscoveredModel> {
    if let Some(id) = row.as_str() {
        let id = id.trim();
        return (!id.is_empty()).then(|| DiscoveredModel {
            id: id.to_string(),
            display_name: None,
        });
    }
    let object = row.as_object()?;
    // `id` is OpenAI and Anthropic; `name` is Ollama; `model` appears on a few
    // OpenAI-compatible gateways that copied the request field instead.
    let id = ["id", "name", "model"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let display_name = ["display_name", "displayName", "name"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|label| !label.is_empty() && *label != id)
        .map(str::to_string);
    Some(DiscoveredModel {
        id: id.to_string(),
        display_name,
    })
}

/// Does this provider type speak Anthropic's auth?
///
/// Mirrors `ProviderKind::detect`'s Anthropic arm rather than calling it: this
/// needs the AUTH shape, and a kind that later gains its own adapter would not
/// necessarily change how its key is presented. Kept beside that list all the
/// same — if one grows an entry, check the other.
fn uses_anthropic_auth(provider_type: &str) -> bool {
    matches!(
        provider_type.trim(),
        "anthropic" | "minimax" | "modal-messages"
    )
}

/// The `/models` URL for a base URL, however the person wrote it.
///
/// A base URL is normally the one the adapters use (`…/v1`), but people paste
/// the endpoint they were given, and `…/v1/chat/completions` is a base URL that
/// works for chat and would ask for `…/chat/completions/models` here. Trimming
/// a known endpoint off the tail first is what makes the button work on a row
/// that was already working.
pub fn models_url(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/');
    // The endpoint only — never a version-qualified form like `/v1/messages`,
    // which would strip the `/v1` the models path also needs and ask
    // `https://api.anthropic.com/models`.
    for endpoint in ["/chat/completions", "/messages", "/responses", "/completions"] {
        if let Some(trimmed) = base.strip_suffix(endpoint) {
            base = trimmed.trim_end_matches('/');
            break;
        }
    }
    if base.ends_with("/models") {
        return base.to_string();
    }
    format!("{base}/models")
}

/// Turn a failed response into a sentence naming the next action.
///
/// The status alone ("Request failed with status 401") tells a person nothing
/// they can act on, and this string is rendered verbatim under the button.
fn explain(status: reqwest::StatusCode, url: &str, body: &str) -> String {
    let detail = body.trim();
    let detail = if detail.is_empty() || detail.len() > 300 {
        String::new()
    } else {
        format!(" The provider said: {detail}")
    };
    match status.as_u16() {
        401 | 403 => format!(
            "The provider rejected the API key ({status}). Check the key on this row.{detail}"
        ),
        404 => format!(
            "No model list at {url} ({status}). This provider may not publish one — add models by \
             id instead.{detail}"
        ),
        429 => format!("Rate-limited by the provider ({status}). Try again shortly.{detail}"),
        _ => format!("The provider answered {status} for {url}.{detail}"),
    }
}

/// Ask a provider for its model list.
///
/// `async` because a sync `#[tauri::command] pub fn` runs on the UI thread in
/// Tauri v2 — see `commands::command_thread_safety`.
#[tauri::command]
pub async fn provider_list_models(
    base_url: String,
    api_key: String,
    provider_type: Option<String>,
) -> Result<Vec<DiscoveredModel>, String> {
    // Subscription rows sign in instead of holding a key, so the key-based
    // request below can only be refused ("x-api-key header is required").
    // Each asks its own backend with the stored sign-in instead.
    let signed_in_list = match provider_type.as_deref().map(str::trim) {
        Some("codex") => Some(crate::api::codex::models::list_models().await),
        Some(crate::api::claude_code::CLAUDE_CODE_PROVIDER_TYPE) => {
            Some(crate::api::claude_code::models::list_models().await)
        }
        _ => None,
    };
    if let Some(listed) = signed_in_list {
        let mut models: Vec<DiscoveredModel> = listed?
            .into_iter()
            .map(|(id, display_name)| DiscoveredModel { id, display_name })
            .collect();
        models.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
        models.dedup_by(|a, b| a.id == b.id);
        return Ok(models);
    }

    if base_url.trim().is_empty() {
        return Err("This provider has no base URL, so there is nowhere to ask.".into());
    }
    let url = models_url(&base_url);
    let kind = provider_type.unwrap_or_default();
    let key = api_key.trim();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(LIST_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("Could not start the request: {e}"))?;

    let mut request = client.get(&url);
    if !key.is_empty() {
        if uses_anthropic_auth(&kind) {
            // Anthropic wants its own header AND a version, and answers 400
            // without the version even when the key is perfect.
            request = request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        } else {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
    }

    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{url} did not answer within {}s.", LIST_TIMEOUT_MS / 1000)
        } else {
            format!("Could not reach {url}: {e}")
        }
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(explain(status, &url, &body));
    }

    let parsed: ModelsBody = serde_json::from_str(&body).map_err(|_| {
        format!("{url} answered, but not with a model list Aurora could read. Add models by id instead.")
    })?;

    let mut models: Vec<DiscoveredModel> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in parsed.rows() {
        if let Some(model) = row_to_model(&row) {
            // A gateway that fans several upstreams into one list can repeat an
            // id. Keep the first, which is the order the provider chose.
            if seen.insert(model.id.clone()) {
                models.push(model);
            }
        }
    }
    if models.is_empty() {
        return Err(format!(
            "{url} answered with an empty model list. Add models by id instead."
        ));
    }
    models.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_gets_models_appended() {
        assert_eq!(models_url("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
        assert_eq!(models_url("https://api.openai.com/v1/"), "https://api.openai.com/v1/models");
    }

    /// People paste the endpoint they were handed. That string is a working
    /// base URL for chat, so the button has to work on it too rather than
    /// asking `…/chat/completions/models`.
    #[test]
    fn a_pasted_endpoint_is_trimmed_back_to_its_base() {
        for (given, want) in [
            ("https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1/models"),
            ("https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models"),
            ("https://example.ai/v1/responses", "https://example.ai/v1/models"),
        ] {
            assert_eq!(models_url(given), want, "for {given}");
        }
    }

    #[test]
    fn a_url_that_already_names_models_is_left_alone() {
        assert_eq!(models_url("https://api.x.ai/v1/models"), "https://api.x.ai/v1/models");
    }

    #[test]
    fn the_three_listing_shapes_all_read() {
        // OpenAI / Anthropic.
        let wrapped: ModelsBody =
            serde_json::from_str(r#"{"data":[{"id":"gpt-5"},{"id":"o4","display_name":"O4"}]}"#)
                .unwrap();
        let rows = wrapped.rows();
        assert_eq!(row_to_model(&rows[0]).unwrap().id, "gpt-5");
        assert_eq!(
            row_to_model(&rows[1]).unwrap().display_name.as_deref(),
            Some("O4")
        );

        // Ollama.
        let ollama: ModelsBody =
            serde_json::from_str(r#"{"models":[{"name":"qwen3:8b"}]}"#).unwrap();
        assert_eq!(row_to_model(&ollama.rows()[0]).unwrap().id, "qwen3:8b");

        // A bare array, and a bare string inside one.
        let bare: ModelsBody = serde_json::from_str(r#"["glm-5.3",{"id":"kimi-k3"}]"#).unwrap();
        let rows = bare.rows();
        assert_eq!(row_to_model(&rows[0]).unwrap().id, "glm-5.3");
        assert_eq!(row_to_model(&rows[1]).unwrap().id, "kimi-k3");
    }

    /// The id is the wire value. A provider that says `GLM-5.3` does not answer
    /// to `glm-5.3`, so nothing here may re-case it — only the SORT is
    /// case-insensitive, so the list reads alphabetically to a person.
    #[test]
    fn ids_keep_their_exact_casing() {
        let row = serde_json::json!({ "id": "  MiniMax-M3  " });
        assert_eq!(row_to_model(&row).unwrap().id, "MiniMax-M3");
    }

    /// A label identical to the id is noise in the picker, not information.
    #[test]
    fn a_display_name_that_repeats_the_id_is_dropped() {
        let row = serde_json::json!({ "id": "qwen3:8b", "name": "qwen3:8b" });
        assert_eq!(row_to_model(&row).unwrap().display_name, None);
    }

    #[test]
    fn a_row_with_no_usable_id_is_skipped() {
        assert!(row_to_model(&serde_json::json!({ "object": "model" })).is_none());
        assert!(row_to_model(&serde_json::json!({ "id": "   " })).is_none());
    }

    /// Every refusal names the next action, because it renders verbatim under
    /// the button. "Request failed with status 401" is not something a person
    /// can act on.
    #[test]
    fn a_refusal_says_what_to_do_about_it() {
        let key = explain(reqwest::StatusCode::UNAUTHORIZED, "https://x/v1/models", "");
        assert!(key.contains("API key"), "{key}");
        let missing = explain(reqwest::StatusCode::NOT_FOUND, "https://x/v1/models", "");
        assert!(missing.contains("add models by id"), "{missing}");
    }

    #[tokio::test]
    async fn an_empty_base_url_is_refused_in_words_a_person_can_act_on() {
        let err = provider_list_models(String::new(), "k".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("no base URL"), "{err}");
    }
}
