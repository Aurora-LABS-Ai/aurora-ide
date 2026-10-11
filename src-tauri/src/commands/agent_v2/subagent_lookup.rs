//! Agent runtime IPC — the database-backed model lookup for sub-agents.
//!
//! A sub-agent's `model` is a `providerId:modelKey` pin. Turning that into a
//! request means reading the provider row (URL, key, wire type, headers) and
//! the model row (window, output cap, vision, thinking) out of the app's
//! SQLite database — the same rows the Providers page edits. This is the
//! only piece of the sub-agent system that touches the database, and it is
//! Tauri-only because the database is managed Tauri state.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::agent_runtime::subagents::host::{ModelChoice, ProviderLookup, ResolvedModel, SubagentError};
use crate::db::{Database, LLMProvider, ProviderModel};

pub struct DatabaseProviderLookup {
    app: AppHandle,
}

impl DatabaseProviderLookup {
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn rows(&self) -> Result<(Vec<LLMProvider>, Vec<ProviderModel>), String> {
        let state = self
            .app
            .try_state::<Mutex<Database>>()
            .ok_or_else(|| "Aurora's database is not available".to_string())?;
        let db = state
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let providers = db
            .settings()
            .get_all_providers()
            .map_err(|e| format!("could not read providers: {e}"))?;
        let models = db
            .models()
            .list_all()
            .map_err(|e| format!("could not read models: {e}"))?;
        Ok((providers, models))
    }
}

/// A provider's human-facing name: nickname, else name, else id.
fn provider_label(p: &LLMProvider) -> String {
    p.nickname
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            let name = p.name.trim();
            if name.is_empty() {
                p.id.as_str()
            } else {
                name
            }
        })
        .to_string()
}

/// Build the request snapshot from one provider row and one model row.
pub(crate) fn snapshot_for(
    p: &LLMProvider,
    m: &ProviderModel,
    thinking_preference: bool,
) -> Result<ResolvedModel, String> {
    let to_u32 = |n: i64| u32::try_from(n).ok().filter(|n| *n > 0);
    Ok(ResolvedModel {
        provider_id: p.id.clone(),
        model_key: m.model_key.clone(),
        config: crate::api::model_config::resolve(p, m, thinking_preference)?,
        context_window: m.context_window.and_then(to_u32).or(to_u32(p.context_window)),
        max_output_tokens: m.max_output_tokens.and_then(to_u32).or(to_u32(p.max_output_tokens)),
    })
}

impl ProviderLookup for DatabaseProviderLookup {
    fn models(&self) -> Result<Vec<ModelChoice>, String> {
        let (providers, models) = self.rows()?;
        let mut out = Vec::new();
        for m in &models {
            let Some(p) = providers.iter().find(|p| p.id == m.provider_id) else {
                continue;
            };
            if !m.enabled || !p.enabled {
                continue;
            }
            out.push(ModelChoice {
                pin: format!("{}:{}", p.id, m.model_key),
                provider: provider_label(p),
                model: m.model_key.clone(),
                label: m.label.clone().filter(|l| !l.trim().is_empty()),
                context_window: m.context_window.or(Some(p.context_window)).filter(|n| *n > 0),
                price_output_per_mtok: m.price_output_per_mtok,
                current: false,
            });
        }
        Ok(out)
    }

    fn resolve(&self, pin: &str, thinking_preference: bool) -> Result<ResolvedModel, SubagentError> {
        let (provider_part, key) = pin
            .trim()
            .split_once(':')
            .map(|(p, k)| (p.trim(), k.trim()))
            .filter(|(p, k)| !p.is_empty() && !k.is_empty())
            .ok_or_else(|| {
                SubagentError::Invalid(format!("{pin:?} is not a model pin; use providerId:modelKey from list_models"))
            })?;
        let (providers, models) = self.rows().map_err(SubagentError::Start)?;
        // By id first — that is what `list_models` prints — then by the name
        // or nickname a person would type.
        let provider = providers
            .iter()
            .find(|p| p.id == provider_part)
            .or_else(|| {
                providers.iter().find(|p| {
                    p.name.eq_ignore_ascii_case(provider_part)
                        || p.nickname
                            .as_deref()
                            .is_some_and(|n| n.eq_ignore_ascii_case(provider_part))
                })
            })
            .ok_or_else(|| SubagentError::UnknownModel(format!("no configured provider matches {provider_part:?}")))?;
        if !provider.enabled {
            return Err(SubagentError::UnknownModel(format!(
                "provider {:?} is disabled in Settings",
                provider_label(provider)
            )));
        }
        let model = models
            .iter()
            .find(|m| m.provider_id == provider.id && m.model_key == key)
            .or_else(|| {
                models.iter().find(|m| {
                    m.provider_id == provider.id
                        && m.label.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(key))
                })
            })
            .ok_or_else(|| {
                SubagentError::UnknownModel(format!(
                    "provider {:?} has no model {key:?}; list_models shows what it serves",
                    provider_label(provider)
                ))
            })?;
        if !model.enabled {
            return Err(SubagentError::UnknownModel(format!("model {pin:?} is disabled in Settings")));
        }
        snapshot_for(provider, model, thinking_preference).map_err(SubagentError::Invalid)
    }
}
