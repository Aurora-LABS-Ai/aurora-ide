//! The Cursor account's model catalogue.
//!
//! One RPC — `agent.v1.AgentService/GetUsableModels` — mapped onto the rows
//! [`crate::db::repositories::CursorModelsRepository`] stores. There is no
//! hardcoded fallback list: a stale built-in roster is how a picker ends up
//! offering models the account cannot reach, which fails at the first request
//! with an error that blames the model rather than the catalogue.

use cursor_proto::agent::{GetUsableModelsRequest, GetUsableModelsResponse, ModelDetails};
use cursor_proto::Message;

use crate::db::CursorModel;

/// Full RPC path for the catalogue call.
const GET_USABLE_MODELS: &str = "/agent.v1.AgentService/GetUsableModels";

/// Fetch every model the signed-in account can reach, in Cursor's own order.
pub async fn fetch(access_token: &str) -> Result<Vec<CursorModel>, String> {
    let request = GetUsableModelsRequest {
        // Empty: this field exists to ask about *custom* models the caller
        // supplies its own credentials for, which Aurora does not do here.
        custom_model_ids: Vec::new(),
    };
    let response = super::unary::call(GET_USABLE_MODELS, request.encode_to_vec(), access_token)
        .await?;

    let decoded = GetUsableModelsResponse::decode(response.as_slice())
        .map_err(|err| format!("Cursor sent a model list Aurora could not read: {err}"))?;

    let models: Vec<CursorModel> = decoded
        .models
        .iter()
        .enumerate()
        .filter_map(|(index, details)| to_row(details, index as i64))
        .collect();

    if models.is_empty() {
        return Err("Cursor returned no usable models for this account.".to_string());
    }
    Ok(models)
}

/// Map one upstream `ModelDetails` onto a stored row.
///
/// Returns `None` for an entry with no id — there is nothing to send as the
/// model, so listing it would only produce a selectable row that always fails.
fn to_row(details: &ModelDetails, sort_order: i64) -> Option<CursorModel> {
    let model_id = details.model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    Some(CursorModel {
        model_id: model_id.to_string(),
        display_model_id: non_empty(&details.display_model_id),
        display_name: non_empty(&details.display_name),
        display_name_short: non_empty(&details.display_name_short),
        aliases: details
            .aliases
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .map(str::to_string)
            .collect(),
        // `ThinkingDetails` is an empty message upstream — its *presence* is
        // the entire signal. There are no fields to read.
        supports_thinking: details.thinking_details.is_some(),
        max_mode: details.max_mode.unwrap_or(false),
        // Not ours to decide. The catalogue says what exists; whether a model
        // reaches the selector is the user's choice, carried across refreshes
        // by the repository.
        enabled: false,
        sort_order,
    })
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cursor_proto::agent::ThinkingDetails;

    fn details(model_id: &str) -> ModelDetails {
        ModelDetails {
            model_id: model_id.to_string(),
            display_model_id: String::new(),
            display_name: String::new(),
            display_name_short: String::new(),
            aliases: Vec::new(),
            thinking_details: None,
            max_mode: None,
            credentials: None,
        }
    }

    #[test]
    fn maps_identity_and_labels() {
        let row = to_row(
            &ModelDetails {
                display_model_id: "claude-opus-5".into(),
                display_name: "Claude Opus 5 (Thinking, High)".into(),
                display_name_short: "Opus 5".into(),
                aliases: vec!["opus".into(), "opus-5".into()],
                ..details("claude-opus-5-thinking-high")
            },
            3,
        )
        .expect("row");

        assert_eq!(row.model_id, "claude-opus-5-thinking-high");
        assert_eq!(row.display_model_id.as_deref(), Some("claude-opus-5"));
        assert_eq!(row.label(), "Claude Opus 5 (Thinking, High)");
        assert_eq!(row.aliases, vec!["opus", "opus-5"]);
        assert_eq!(row.sort_order, 3);
    }

    #[test]
    fn thinking_is_signalled_by_presence_not_by_a_field() {
        let plain = to_row(&details("gpt-5.2"), 0).unwrap();
        assert!(!plain.supports_thinking);

        let thinking = to_row(
            &ModelDetails {
                thinking_details: Some(ThinkingDetails {}),
                ..details("claude-opus-5-thinking-high")
            },
            0,
        )
        .unwrap();
        assert!(thinking.supports_thinking);
    }

    #[test]
    fn max_mode_defaults_to_off_when_absent() {
        assert!(!to_row(&details("a"), 0).unwrap().max_mode);
        assert!(
            to_row(
                &ModelDetails {
                    max_mode: Some(true),
                    ..details("a")
                },
                0
            )
            .unwrap()
            .max_mode
        );
    }

    #[test]
    fn an_entry_without_an_id_is_dropped() {
        assert!(to_row(&details(""), 0).is_none());
        assert!(to_row(&details("   "), 0).is_none());
    }

    #[test]
    fn blank_labels_do_not_become_empty_strings() {
        let row = to_row(
            &ModelDetails {
                display_name: "   ".into(),
                aliases: vec!["".into(), "  ".into(), "real".into()],
                ..details("m")
            },
            0,
        )
        .unwrap();
        assert_eq!(row.display_name, None);
        assert_eq!(row.aliases, vec!["real"]);
        // With every label blank, the id is what the picker shows.
        assert_eq!(row.label(), "m");
    }

    /// Hits Cursor's real API with the developer's own signed-in session.
    ///
    /// Ignored by default. Run with:
    ///
    /// ```text
    /// cargo test --lib api::cursor::models -- --ignored --nocapture
    /// ```
    ///
    /// This is the first call that leaves the machine, so it proves the whole
    /// lower stack at once: token read, unary Connect framing, and protobuf
    /// decode against a response Aurora did not author.
    #[tokio::test]
    #[ignore = "calls Cursor's live API with the developer's session"]
    async fn fetches_the_live_account_catalogue() {
        let token = crate::api::cursor::auth::fresh_access(false)
            .await
            .expect("a signed-in Cursor session is required");

        let models = fetch(&token).await.expect("GetUsableModels");
        println!("{} models on this account", models.len());

        for model in models.iter().take(8) {
            println!(
                "  {:<44} thinking={:<5} max={:<5} {}",
                model.model_id,
                model.supports_thinking,
                model.max_mode,
                model.label()
            );
        }

        // The ids Grok ships under already begin with `cursor-` upstream —
        // that prefix is part of the real id, not something a gateway added.
        // Print them so the exact string to send is never guessed at.
        println!("grok ids:");
        for model in models.iter().filter(|m| m.model_id.contains("grok")) {
            println!("  {}", model.model_id);
        }

        // How the provider page will actually look: pairs collapsed, older
        // generations folded away. Printed rather than asserted because the
        // numbers depend on the account.
        let bases: std::collections::BTreeSet<&str> =
            models.iter().map(|m| m.base_model_id()).collect();
        let legacy: Vec<&str> = models
            .iter()
            .filter(|m| m.is_legacy())
            .map(|m| m.model_id.as_str())
            .collect();
        let current_bases: std::collections::BTreeSet<&str> = models
            .iter()
            .filter(|m| !m.is_legacy())
            .map(|m| m.base_model_id())
            .collect();

        println!(
            "\n{} rows → {} base models → {} current base models ({} legacy rows hidden)",
            models.len(),
            bases.len(),
            current_bases.len(),
            legacy.len()
        );
        println!("hidden as older generations:");
        for id in legacy.iter().take(24) {
            println!("  {id}");
        }

        // What the provider page should really show: one row per *model*,
        // with effort and thinking as options on it rather than as separate
        // entries. `claude-fable-5` alone ships ten rows otherwise.
        let mut by_model: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for m in models.iter().filter(|m| !m.is_legacy()) {
            *by_model
                .entry(m.catalog_key().unwrap_or_else(|| m.model_id.clone()))
                .or_default() += 1;
        }
        println!(
            "\ngrouped by model: {} rows (from {} current variants)",
            by_model.len(),
            models.iter().filter(|m| !m.is_legacy()).count()
        );
        for (key, variants) in by_model.iter().take(40) {
            println!("  {key:<40} {variants} variants");
        }

        assert!(!models.is_empty());
        assert!(
            models.iter().all(|m| !m.model_id.trim().is_empty()),
            "every listed model must carry an id we can actually send"
        );
        assert!(
            !current_bases.is_empty(),
            "the generation filter must never hide everything"
        );
    }

    /// The wire round-trip, without a network: encode a response the way
    /// Cursor would, then decode and map it.
    #[test]
    fn decodes_a_real_shaped_response() {
        let response = GetUsableModelsResponse {
            models: vec![
                details("auto"),
                ModelDetails {
                    display_name: "Composer 2.5".into(),
                    thinking_details: Some(ThinkingDetails {}),
                    ..details("composer-2.5")
                },
            ],
        };
        let bytes = response.encode_to_vec();

        let decoded = GetUsableModelsResponse::decode(bytes.as_slice()).expect("decode");
        let rows: Vec<CursorModel> = decoded
            .models
            .iter()
            .enumerate()
            .filter_map(|(i, d)| to_row(d, i as i64))
            .collect();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].model_id, "auto");
        assert_eq!(rows[1].label(), "Composer 2.5");
        assert!(rows[1].supports_thinking);
        assert_eq!(rows[1].sort_order, 1, "upstream order is preserved");
    }
}
