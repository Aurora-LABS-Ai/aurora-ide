//! Answering "which model?" from a terminal.
//!
//! A model name does not identify a model in Aurora. `glm-5.2` is served by
//! several configured providers at different context windows, different
//! prices, and — as `.knowledge` records for the relabelling gateways — in at
//! least one case a different model wearing the name. The thing that
//! identifies a model is the **pair**: `providerId:modelKey`.
//!
//! So `--model glm-5.2` is a *query*, not an answer, and this module is what
//! turns one into the other:
//!
//! - exactly one match → use it, silently
//! - several matches, terminal attached → ask, with the differences shown
//! - several matches, no terminal → refuse, and print the qualified names so
//!   the caller can pick one and re-run
//! - no matches → refuse, with near-misses if there are any
//!
//! The refuse-when-ambiguous rule is the important one. A script that says
//! `--model glm-5.2` and silently gets whichever provider sorted first is a
//! script that bills the wrong account and reports the wrong model in its
//! logs. Guessing here is worse than stopping.

use crate::db::{Database, LLMProvider, ProviderModel};

/// One selectable model, flattened across the provider join.
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub provider_id: String,
    /// The provider's display name, for output. Falls back to the id.
    pub provider_name: String,
    pub model_key: String,
    /// The model's own display label, when it has one.
    pub label: Option<String>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub supports_vision: bool,
    pub supports_thinking: bool,
    /// USD per 1M output tokens, when priced. The single most useful number
    /// for telling two same-named models apart at a glance.
    pub price_output_per_mtok: Option<f64>,
    /// Whether this is the pair `selectedModel` currently points at.
    pub selected: bool,
}

impl CatalogEntry {
    /// `providerId:modelKey` — the form the rest of Aurora pins a
    /// conversation's model in.
    ///
    /// Internal. A user-added provider's id is a UUID, so this is not
    /// something to print or ask anyone to type — see [`Self::display_pin`].
    pub fn pin(&self) -> String {
        format!("{}:{}", self.provider_id, self.model_key)
    }

    /// The qualified name to *show*, and the one a user can type back.
    ///
    /// Built-in providers have readable ids (`fireworks`, `anthropic`) and a
    /// user-added one has a UUID. Printing the UUID would make the qualified
    /// form — the entire mechanism for choosing between providers serving the
    /// same model name — impossible to use: nobody types
    /// `--model 0acc2133-94c9-43d6-96ca-cf4e3ba6afd6:glm-5.2`.
    ///
    /// So the display form uses the provider's *name*, and [`Catalog::find`]
    /// accepts either. The id remains what is written to a task request.
    pub fn display_pin(&self) -> String {
        format!("{}:{}", self.provider_label(), self.model_key)
    }

    /// The provider as a person refers to it: its name, or its id when the
    /// name is missing.
    pub fn provider_label(&self) -> &str {
        let name = self.provider_name.trim();
        if name.is_empty() {
            &self.provider_id
        } else {
            name
        }
    }

    /// Whether `query` names this entry's provider — by id or by name.
    fn provider_matches(&self, query: &str) -> bool {
        self.provider_id.eq_ignore_ascii_case(query)
            || self.provider_name.trim().eq_ignore_ascii_case(query)
    }

    /// What to show a human: the label if there is one, else the key.
    pub fn display_name(&self) -> &str {
        self.label
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(&self.model_key)
    }
}

/// Everything the CLI knows about configured models.
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    /// The `providerId:modelKey` the app currently has selected, if any.
    pub selected: Option<String>,
}

/// Why a model query could not be answered.
#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("could not read Aurora's settings database: {0}")]
    Db(#[from] crate::db::DbError),

    #[error(
        "no providers are configured yet — open Aurora, add a provider under \
         Settings, then run this again"
    )]
    Empty,

    #[error("no model matches {query:?}")]
    NoMatch {
        query: String,
        /// Names close enough to be worth printing as suggestions.
        near: Vec<String>,
    },

    #[error("{query:?} is ambiguous — it is configured on {} providers", candidates.len())]
    Ambiguous {
        query: String,
        candidates: Vec<CatalogEntry>,
    },
}

impl Catalog {
    /// Read the configured providers and models from Aurora's own database.
    ///
    /// A database with no tables — the CLI ran before Aurora ever started — is
    /// reported as [`CatalogError::Empty`], not as a SQL failure. It is a
    /// first-run state with an obvious remedy, and a raw
    /// `no such table: provider_models` tells the user nothing about it.
    pub fn load() -> Result<Self, CatalogError> {
        let db = Database::open_headless()?;

        let providers: Vec<LLMProvider> = db.settings().get_all_providers().unwrap_or_default();
        if providers.is_empty() {
            return Err(CatalogError::Empty);
        }

        let models: Vec<ProviderModel> = db.models().list_all().unwrap_or_default();
        let selected = db
            .settings()
            .get_app_settings()
            .ok()
            .map(|settings| settings.selected_model)
            .filter(|pin| !pin.trim().is_empty());

        let mut entries: Vec<CatalogEntry> = Vec::new();
        for model in models {
            // A model row whose provider was deleted is orphaned config, not a
            // usable choice; offering it would produce a dispatch that fails
            // at request time with no key to send.
            let Some(provider) = providers
                .iter()
                .find(|provider| provider.id == model.provider_id)
            else {
                continue;
            };
            if !model.enabled || !provider.enabled {
                continue;
            }
            let pin = format!("{}:{}", model.provider_id, model.model_key);
            entries.push(CatalogEntry {
                provider_id: model.provider_id.clone(),
                provider_name: display_provider_name(provider),
                model_key: model.model_key.clone(),
                label: model.label.clone(),
                context_window: model.context_window,
                max_output_tokens: model.max_output_tokens,
                supports_vision: model.supports_vision,
                supports_thinking: model.supports_thinking,
                price_output_per_mtok: model.price_output_per_mtok,
                selected: selected.as_deref() == Some(pin.as_str()),
            });
        }

        // Stable, meaningful order: provider first, then model. The list is
        // read by a human scanning for a name, and grouping every provider's
        // models together is what makes that scan short.
        entries.sort_by(|a, b| {
            a.provider_id
                .cmp(&b.provider_id)
                .then_with(|| a.model_key.cmp(&b.model_key))
        });

        if entries.is_empty() {
            return Err(CatalogError::Empty);
        }

        Ok(Self { entries, selected })
    }

    /// The entry the app currently has selected, if it still exists.
    pub fn selected_entry(&self) -> Option<&CatalogEntry> {
        self.entries.iter().find(|entry| entry.selected)
    }

    /// Every entry matching a query, which may be a bare model name
    /// (`glm-5.2`) or a qualified pin (`fireworks:glm-5.2`).
    ///
    /// Matching is case-insensitive, and a bare query is tried against both
    /// the model key and its display label — the picker in the window shows
    /// labels, so a label is what a user is most likely to type back.
    pub fn find(&self, query: &str, provider_filter: Option<&str>) -> Vec<CatalogEntry> {
        let query = query.trim();
        let (provider_from_query, name) = match query.split_once(':') {
            Some((provider, model)) => (Some(provider.trim()), model.trim()),
            None => (None, query),
        };
        // An explicit `--provider` and a qualified `--model provider:key` are
        // both ways of saying the same thing; when both appear the explicit
        // flag wins, since it is the more specific instruction.
        let provider = provider_filter.or(provider_from_query);

        self.entries
            .iter()
            .filter(|entry| provider.is_none_or(|wanted| entry.provider_matches(wanted)))
            .filter(|entry| {
                entry.model_key.eq_ignore_ascii_case(name)
                    || entry
                        .label
                        .as_deref()
                        .is_some_and(|label| label.eq_ignore_ascii_case(name))
            })
            .cloned()
            .collect()
    }

    /// Resolve a query to exactly one entry, or explain why it cannot.
    ///
    /// This never picks for the user. See the module docs: a silent choice
    /// between two providers serving the same name is a wrong bill and a wrong
    /// log line, and both are discovered far too late.
    pub fn resolve(
        &self,
        query: &str,
        provider_filter: Option<&str>,
    ) -> Result<CatalogEntry, CatalogError> {
        let matches = self.find(query, provider_filter);
        match matches.len() {
            1 => Ok(matches.into_iter().next().expect("length checked")),
            0 => Err(CatalogError::NoMatch {
                query: query.to_string(),
                near: self.near_matches(query),
            }),
            _ => Err(CatalogError::Ambiguous {
                query: query.to_string(),
                candidates: matches,
            }),
        }
    }

    /// Names worth suggesting after a miss.
    ///
    /// Substring both ways, which covers the two mistakes people actually
    /// make: typing a fragment (`glm` for `glm-5.2`) and typing something
    /// longer than the key (`glm-5.2-chat` for `glm-5.2`). Not an edit-distance
    /// search — that would need a threshold to tune and would suggest
    /// confidently wrong models, which is worse than suggesting nothing.
    fn near_matches(&self, query: &str) -> Vec<String> {
        let needle = query.trim().to_ascii_lowercase();
        // A bare `:` or empty query would match everything; suggest nothing
        // rather than printing the entire catalogue as "near misses".
        if needle.len() < 2 {
            return Vec::new();
        }
        let mut near: Vec<String> = self
            .entries
            .iter()
            .filter(|entry| {
                let key = entry.model_key.to_ascii_lowercase();
                key.contains(&needle) || needle.contains(&key)
            })
            // Suggestions must be typeable, so they carry the provider's name
            // rather than its id.
            .map(|entry| entry.display_pin())
            .collect();
        near.sort();
        near.dedup();
        near.truncate(8);
        near
    }
}

/// A provider's human-facing name.
///
/// The nickname wins when set: it is the field the user edits precisely
/// because two providers would otherwise be indistinguishable in a list, which
/// is exactly the situation this CLI is for.
fn display_provider_name(provider: &LLMProvider) -> String {
    provider
        .nickname
        .as_deref()
        .map(str::trim)
        .filter(|nickname| !nickname.is_empty())
        .unwrap_or(&provider.name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: &str, model: &str) -> CatalogEntry {
        CatalogEntry {
            provider_id: provider.to_string(),
            provider_name: provider.to_string(),
            model_key: model.to_string(),
            label: None,
            context_window: Some(128_000),
            max_output_tokens: Some(8_192),
            supports_vision: false,
            supports_thinking: false,
            price_output_per_mtok: None,
            selected: false,
        }
    }

    /// The situation this module exists for: one name, several providers.
    fn contested() -> Catalog {
        Catalog {
            entries: vec![
                entry("fireworks", "glm-5.2"),
                entry("openstarry", "glm-5.2"),
                entry("x5m5x", "glm-5.2"),
                entry("fireworks", "kimi-k3"),
            ],
            selected: Some("fireworks:kimi-k3".to_string()),
        }
    }

    #[test]
    fn a_unique_name_resolves() {
        let resolved = contested().resolve("kimi-k3", None).expect("resolves");
        assert_eq!(resolved.pin(), "fireworks:kimi-k3");
    }

    #[test]
    fn a_contested_name_refuses_rather_than_guessing() {
        let error = contested().resolve("glm-5.2", None).unwrap_err();
        match error {
            CatalogError::Ambiguous { candidates, .. } => {
                assert_eq!(candidates.len(), 3);
                // Every candidate is offered qualified, so the user can copy
                // one straight back into the command.
                assert!(candidates.iter().any(|c| c.pin() == "openstarry:glm-5.2"));
            }
            other => panic!("expected an ambiguity, got {other:?}"),
        }
    }

    #[test]
    fn a_provider_flag_disambiguates() {
        let resolved = contested()
            .resolve("glm-5.2", Some("x5m5x"))
            .expect("resolves");
        assert_eq!(resolved.pin(), "x5m5x:glm-5.2");
    }

    #[test]
    fn a_qualified_model_disambiguates_without_the_flag() {
        let resolved = contested()
            .resolve("openstarry:glm-5.2", None)
            .expect("resolves");
        assert_eq!(resolved.pin(), "openstarry:glm-5.2");
    }

    #[test]
    fn the_explicit_provider_flag_outranks_the_qualifier() {
        // `--provider fireworks --model x5m5x:glm-5.2` is contradictory; the
        // flag is the more specific instruction, so it wins.
        let resolved = contested()
            .resolve("x5m5x:glm-5.2", Some("fireworks"))
            .expect("resolves");
        assert_eq!(resolved.pin(), "fireworks:glm-5.2");
    }

    #[test]
    fn matching_ignores_case() {
        let resolved = contested().resolve("KIMI-K3", None).expect("resolves");
        assert_eq!(resolved.pin(), "fireworks:kimi-k3");
    }

    #[test]
    fn a_label_matches_as_well_as_a_key() {
        let mut catalog = contested();
        catalog.entries.push(CatalogEntry {
            label: Some("Sonnet 5".to_string()),
            ..entry("anthropic", "claude-sonnet-5")
        });
        let resolved = catalog.resolve("Sonnet 5", None).expect("resolves");
        assert_eq!(resolved.pin(), "anthropic:claude-sonnet-5");
    }

    #[test]
    fn a_miss_suggests_near_names() {
        let error = contested().resolve("glm", None).unwrap_err();
        match error {
            CatalogError::NoMatch { near, .. } => {
                // `glm` is a fragment of three real keys.
                assert_eq!(near.len(), 3);
                assert!(near.contains(&"fireworks:glm-5.2".to_string()));
            }
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn a_miss_with_nothing_close_suggests_nothing() {
        let error = contested().resolve("gpt-9", None).unwrap_err();
        match error {
            CatalogError::NoMatch { near, .. } => assert!(near.is_empty()),
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn a_one_character_query_does_not_suggest_the_whole_catalogue() {
        let error = contested().resolve("g", None).unwrap_err();
        match error {
            CatalogError::NoMatch { near, .. } => assert!(near.is_empty()),
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn a_wrong_provider_is_a_miss_not_a_wrong_model() {
        // The provider exists and the model exists, but not together. Falling
        // back to "the model on some other provider" would be the exact
        // silent-substitution this module refuses.
        let error = contested().resolve("kimi-k3", Some("x5m5x")).unwrap_err();
        assert!(matches!(error, CatalogError::NoMatch { .. }));
    }

    #[test]
    fn the_selected_entry_is_findable() {
        let catalog = Catalog {
            entries: vec![
                entry("fireworks", "glm-5.2"),
                CatalogEntry {
                    selected: true,
                    ..entry("fireworks", "kimi-k3")
                },
            ],
            selected: Some("fireworks:kimi-k3".to_string()),
        };
        assert_eq!(
            catalog.selected_entry().map(CatalogEntry::pin).as_deref(),
            Some("fireworks:kimi-k3")
        );
    }

    /// A user-added provider, as they actually appear in a real database:
    /// a UUID for an id and a human name beside it.
    fn uuid_provider() -> Catalog {
        Catalog {
            entries: vec![
                CatalogEntry {
                    provider_id: "0acc2133-94c9-43d6-96ca-cf4e3ba6afd6".to_string(),
                    provider_name: "openstarry".to_string(),
                    ..entry("ignored", "glm-5.2")
                },
                CatalogEntry {
                    provider_id: "15540891-6714-4849-963a-11d800312bed".to_string(),
                    provider_name: "x5m5x".to_string(),
                    ..entry("ignored", "glm-5.2")
                },
            ],
            selected: None,
        }
    }

    #[test]
    fn a_provider_can_be_named_rather_than_uuided() {
        // The bug this closes: with UUID provider ids, the qualified form —
        // the entire mechanism for choosing between providers serving one
        // model name — was untypeable.
        let resolved = uuid_provider()
            .resolve("glm-5.2", Some("x5m5x"))
            .expect("resolves by provider name");
        assert_eq!(resolved.provider_id, "15540891-6714-4849-963a-11d800312bed");
    }

    #[test]
    fn a_qualified_query_accepts_a_provider_name() {
        let resolved = uuid_provider()
            .resolve("openstarry:glm-5.2", None)
            .expect("resolves");
        assert_eq!(resolved.provider_id, "0acc2133-94c9-43d6-96ca-cf4e3ba6afd6");
    }

    #[test]
    fn the_provider_id_still_matches_when_it_is_readable() {
        // Built-in providers keep readable ids; both forms must work.
        let resolved = contested()
            .resolve("glm-5.2", Some("fireworks"))
            .expect("resolves");
        assert_eq!(resolved.provider_id, "fireworks");
    }

    #[test]
    fn the_displayed_pin_is_the_one_you_can_type_back() {
        let entry = &uuid_provider().entries[0];
        assert_eq!(entry.display_pin(), "openstarry:glm-5.2");
        // The internal pin keeps the id, because that is what the app stores.
        assert_eq!(entry.pin(), "0acc2133-94c9-43d6-96ca-cf4e3ba6afd6:glm-5.2");
    }

    #[test]
    fn a_provider_with_no_name_falls_back_to_its_id() {
        let entry = CatalogEntry {
            provider_id: "some-id".to_string(),
            provider_name: "  ".to_string(),
            ..entry("ignored", "glm-5.2")
        };
        assert_eq!(entry.provider_label(), "some-id");
    }

    #[test]
    fn suggestions_are_typeable() {
        let error = uuid_provider().resolve("glm", None).unwrap_err();
        match error {
            CatalogError::NoMatch { near, .. } => {
                assert!(near.contains(&"openstarry:glm-5.2".to_string()));
                assert!(
                    !near.iter().any(|name| name.contains("0acc2133")),
                    "a suggestion must not be a UUID: {near:?}"
                );
            }
            other => panic!("expected a miss, got {other:?}"),
        }
    }

    #[test]
    fn display_name_prefers_a_label() {
        let mut entry = entry("anthropic", "claude-sonnet-5");
        assert_eq!(entry.display_name(), "claude-sonnet-5");
        entry.label = Some("Sonnet 5".to_string());
        assert_eq!(entry.display_name(), "Sonnet 5");
        // A blank label is not a label.
        entry.label = Some("   ".to_string());
        assert_eq!(entry.display_name(), "claude-sonnet-5");
    }
}
