//! The provider snapshot and the model knobs a turn sends, resolved in the
//! engine from the same rows the window reads.
//!
//! Today `useAgentWindowSend` turns the chat's `"providerId:modelKey"`
//! selection into the request's `providerConfig` (URL, key, wire, custom
//! fields, the typed reasoning request), the wire `model`, `temperature`,
//! `maxOutputTokens`, `contextWindow`, the legacy thinking pair and the
//! compaction provider (`resolveModelRequest` in `model-request-config.ts`,
//! then `AgentRuntimeClient.buildRequest`). Phase 3.6 of
//! `DOCS/rust-core-extraction.md`: the engine does the same from SQLite, so
//! the API key stops travelling in every request once the switch is thrown.
//!
//! A port, field by field, of: `dbToProvider` / `dbToModel` (how a row lands
//! in the store), `buildProviderConfigForSelection` and `getLLMConfig` (the
//! fallbacks), `withProviderDefaults`, `resolveModelRequestKnobs` (reusing
//! `api::model_config::reasoning_for`, proven on the shared fixtures),
//! `applyCursorVariant` / `applyAntigravityVariant` / `applyOpenCodeWire`,
//! `buildProviderConfigSnapshot`, and the knobs the send path computes.
//! Proven against `golden/provider/` (written by
//! `agent-provider.golden.test.ts`), then in shadow on real turns
//! ([`report_shadow_model`]).
//!
//! One input the engine cannot read: Cursor's per-row Fast preference lives in
//! the window's browser storage, so the window sends it ([`EngineModelFacts`]).

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent_runtime::api_client::ReasoningConfig;
use crate::agent_runtime::ipc::AgentChatRequest;
use crate::api::ProviderConfigSnapshot;
use crate::db::{DatabaseAccess, LLMProvider, ProviderModel};

/// `DEFAULT_MAX_OUTPUT_TOKENS`: the output cap when neither row sets one.
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 64_000;
/// `DEFAULT_CONTEXT_WINDOW`: the window when neither row sets one.
pub const DEFAULT_CONTEXT_WINDOW: u32 = 262_000;

/// What only the window knows about the model choice.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineModelFacts {
    /// `isFastOn(row.id)` for the resolved model row; `None` without a row.
    pub cursor_fast: Option<bool>,
}

/// The rows the resolution reads: every provider, every model, and the ids
/// of the Cursor account's catalogue.
#[derive(Debug, Clone, Default)]
pub struct ProviderRows {
    pub providers: Vec<LLMProvider>,
    pub models: Vec<ProviderModel>,
    pub cursor_catalogue: Vec<String>,
}

impl ProviderRows {
    /// Read the rows from the app's database.
    pub fn load(db: &Arc<dyn DatabaseAccess>) -> Result<Self, String> {
        let mut rows = Err("Aurora's database is not available".to_string());
        db.with_db(&mut |db| {
            rows = (|| {
                Ok(Self {
                    providers: db
                        .settings()
                        .get_all_providers()
                        .map_err(|e| format!("could not read providers: {e}"))?,
                    models: db.models().list_all().map_err(|e| format!("could not read models: {e}"))?,
                    cursor_catalogue: db
                        .cursor_models()
                        .list()
                        .map_err(|e| format!("could not read the Cursor catalogue: {e}"))?
                        .into_iter()
                        .map(|model| model.model_id)
                        .collect(),
                })
            })();
        });
        rows
    }
}

/// What a turn asks for.
#[derive(Debug, Clone, Copy)]
pub struct TurnModelInputs<'a> {
    /// The chat's `"providerId:modelKey"`.
    pub selection: &'a str,
    /// Settings → the active selection, the fallback for a deleted provider.
    pub selected_model: &'a str,
    /// Settings → Agent → compaction model; empty for none.
    pub compaction_model: &'a str,
    /// Settings → the global thinking switch.
    pub thinking_preference: bool,
    pub facts: &'a EngineModelFacts,
}

/// The slice of the request the window derives from the selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTurnModel {
    pub provider_id: String,
    /// The wire id: Cursor and Antigravity fold their controls into it.
    pub model: String,
    pub provider_config: ProviderConfigSnapshot,
    pub temperature: Option<f32>,
    pub max_output_tokens: u32,
    pub context_window: u32,
    pub thinking_enabled: Option<bool>,
    pub thinking_budget_tokens: Option<u32>,
    pub compaction_provider_config: Option<ProviderConfigSnapshot>,
}

/// Resolve a turn's model the way the window does. `Ok(None)` when no
/// provider resolves at all (the window then refuses the turn); `Err` for a
/// Cursor run the account does not offer (same), with the window's message.
pub fn resolve_turn_model(
    rows: &ProviderRows,
    inputs: TurnModelInputs<'_>,
) -> Result<Option<ResolvedTurnModel>, String> {
    let Some(resolved) = resolve_request(rows, inputs.selection, inputs.selected_model, inputs.thinking_preference, inputs.facts)?
    else {
        return Ok(None);
    };
    // `resolveModelRequest(settings.compactionModel)` inside a try: a pin
    // that throws leaves the summariser on the chat's own model. A pin whose
    // provider is gone falls back like any selection does.
    let compaction_provider_config = if inputs.compaction_model.is_empty() {
        None
    } else {
        resolve_request(rows, inputs.compaction_model, inputs.selected_model, inputs.thinking_preference, inputs.facts)
            .ok()
            .flatten()
            .map(|r| r.provider_config)
    };
    Ok(Some(ResolvedTurnModel { compaction_provider_config, ..resolved }))
}

// ── Rows as the store holds them ─────────────────────────────────────────────

/// `dbToProvider`: a `0` temperature or cap is "unset", an empty pool is none,
/// a JSON `null` column is none while `{}` stays an object.
struct StoreProvider<'a> {
    row: &'a LLMProvider,
    api_keys: Option<Vec<String>>,
    custom_headers: Option<Value>,
    custom_params: Option<Map<String, Value>>,
    default_temperature: Option<f64>,
    default_max_tokens: Option<i64>,
}

fn store_provider(row: &LLMProvider) -> StoreProvider<'_> {
    StoreProvider {
        row,
        api_keys: row
            .api_keys
            .as_ref()
            .and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
            .filter(|keys| !keys.is_empty()),
        custom_headers: row.custom_headers.clone().filter(|v| !v.is_null()),
        custom_params: row.custom_params.as_ref().and_then(Value::as_object).cloned(),
        default_temperature: row.default_temperature.filter(|t| *t != 0.0),
        default_max_tokens: row.default_max_tokens.filter(|n| *n != 0),
    }
}

/// `ProviderConfig` as the window builds it before the snapshot.
#[derive(Debug, Clone)]
struct WindowConfig {
    id: String,
    base_url: String,
    api_key: String,
    api_keys: Option<Vec<String>>,
    model: String,
    max_output_tokens: i64,
    context_window: i64,
    supports_thinking: bool,
    supports_vision: bool,
    tool_images_in_result: bool,
    provider_type: String,
    custom_headers: Option<Value>,
    custom_params: Option<Map<String, Value>>,
    default_temperature: Option<f64>,
    default_max_tokens: Option<i64>,
    reasoning: Option<ReasoningConfig>,
}

/// The common body of `buildProviderConfigForSelection` and `getLLMConfig`:
/// the provider row with the model row laid over it. `with_pool` is the one
/// difference between them: only the active-config path carries `apiKeys`.
fn config_from_rows(
    provider: &StoreProvider<'_>,
    model: Option<&ProviderModel>,
    model_key: &str,
    with_pool: bool,
) -> WindowConfig {
    let row = provider.row;
    WindowConfig {
        id: row.id.clone(),
        base_url: row.base_url.clone(),
        api_key: row.api_key.clone(),
        api_keys: if with_pool { provider.api_keys.clone() } else { None },
        model: model
            .map(|m| m.model_key.as_str())
            .filter(|k| !k.is_empty())
            .or(Some(model_key).filter(|k| !k.is_empty()))
            .unwrap_or(row.model.as_str())
            .to_string(),
        max_output_tokens: model.and_then(|m| m.max_output_tokens).unwrap_or(row.max_output_tokens),
        context_window: model.and_then(|m| m.context_window).unwrap_or(row.context_window),
        supports_thinking: model.is_some_and(|m| m.supports_thinking),
        supports_vision: model.is_some_and(|m| m.supports_vision),
        tool_images_in_result: row.tool_images_in_result,
        provider_type: model
            .and_then(|m| m.provider_type.clone())
            .or_else(|| row.provider_type.clone())
            .unwrap_or_else(|| "custom".to_string()),
        custom_headers: provider.custom_headers.clone(),
        custom_params: provider.custom_params.clone(),
        default_temperature: provider.default_temperature,
        default_max_tokens: provider.default_max_tokens,
        reasoning: None,
    }
}

fn find_model<'a>(rows: &'a ProviderRows, provider_id: &str, model_key: &str) -> Option<&'a ProviderModel> {
    rows.models.iter().find(|m| m.provider_id == provider_id && m.model_key == model_key)
}

/// `buildProviderConfigForSelection`: `None` when the provider is unknown.
fn config_for_selection(rows: &ProviderRows, selection: &str) -> Option<WindowConfig> {
    let (provider_id, model_key) = match selection.find(':') {
        Some(at) => (&selection[..at], &selection[at + 1..]),
        None => (selection, ""),
    };
    if provider_id.is_empty() {
        return None;
    }
    let provider = rows.providers.iter().find(|p| p.id == provider_id)?;
    let model = find_model(rows, provider_id, model_key);
    Some(config_from_rows(&store_provider(provider), model, model_key, false))
}

/// `getLLMConfig`: the active selection, else the first enabled provider with
/// a key and its first enabled model, else nothing.
fn active_config(rows: &ProviderRows, selected_model: &str) -> Option<WindowConfig> {
    // `selectedModel.split(":")` reads the first two pieces only.
    let mut parts = selected_model.split(':');
    let provider_id = parts.next().unwrap_or("");
    let model_key = parts.next().unwrap_or("");
    if let Some(provider) = rows.providers.iter().find(|p| p.id == provider_id) {
        let model = find_model(rows, provider_id, model_key);
        return Some(config_from_rows(&store_provider(provider), model, model_key, true));
    }
    let fallback = rows.providers.iter().find(|p| p.enabled && !p.api_key.is_empty())?;
    // `.filter(enabled).sort(sortOrder)[0]`: a stable sort, so ties keep row order.
    let model = rows
        .models
        .iter()
        .filter(|m| m.provider_id == fallback.id && m.enabled)
        .min_by_key(|m| m.sort_order);
    Some(config_from_rows(&store_provider(fallback), model, "", true))
}

/// `withProviderDefaults`.
fn with_defaults(mut config: WindowConfig) -> WindowConfig {
    if config.provider_type.is_empty() {
        config.provider_type = "custom".into();
    }
    if config.context_window == 0 {
        config.context_window = i64::from(DEFAULT_CONTEXT_WINDOW);
    }
    if config.max_output_tokens == 0 {
        config.max_output_tokens = i64::from(DEFAULT_MAX_OUTPUT_TOKENS);
    }
    config
}

/// A model row with nothing on it, for a selection that names no row.
fn empty_model() -> ProviderModel {
    serde_json::from_value(serde_json::json!({ "id": "", "providerId": "", "modelKey": "" }))
        .expect("an empty model row")
}

/// `resolveModelRequest`, minus the compaction pin.
fn resolve_request(
    rows: &ProviderRows,
    selection: &str,
    selected_model: &str,
    thinking_preference: bool,
    facts: &EngineModelFacts,
) -> Result<Option<ResolvedTurnModel>, String> {
    let Some(config) = config_for_selection(rows, selection).or_else(|| active_config(rows, selected_model)) else {
        return Ok(None);
    };
    let mut config = with_defaults(config);
    // The row the knobs come from is looked up by the model the config ended
    // up with, which a fallback or an empty key can change.
    let model = find_model(rows, &config.id, &config.model);

    // `resolveModelRequestKnobs`: the reasoning request is read off the row,
    // with the config's own thinking flag (false without a row).
    let mut knobs_model = model.cloned().unwrap_or_else(empty_model);
    knobs_model.supports_thinking = config.supports_thinking;
    let reasoning = crate::api::model_config::reasoning_for(&knobs_model, thinking_preference)?;
    config.reasoning = Some(reasoning.clone());
    if let Some(extra) = model.and_then(|m| m.extra_body.as_ref()).and_then(Value::as_object).filter(|e| !e.is_empty()) {
        let mut merged = config.custom_params.clone().unwrap_or_default();
        for (key, value) in extra {
            if key != "reasoning_replay" {
                merged.insert(key.clone(), value.clone());
            }
        }
        config.custom_params = Some(merged);
    }

    match config.id.as_str() {
        "cursor" => {
            drop_reasoning_effort(&mut config);
            config.model = cursor::resolve_run(&rows.cursor_catalogue, model, &config.model, facts.cursor_fast)?;
        }
        "antigravity" => {
            if let Some(wire) = model.and_then(antigravity_wire_model) {
                config.model = wire;
                drop_reasoning_effort(&mut config);
            }
        }
        "opencode-go" => {
            config.provider_type = opencode_wire_for(
                model.map(|m| m.model_key.as_str()).filter(|k| !k.is_empty()).unwrap_or(&config.model),
                model.and_then(|m| m.provider_type.as_deref()),
            )
            .to_string();
        }
        _ => {}
    }

    // The knobs beside the snapshot (`useAgentWindowSend` → `buildRequest`).
    let temperature = model
        .and_then(|m| m.temperature)
        .or(config.default_temperature)
        .map(|t| t as f32);
    let max_output_tokens = config.default_max_tokens.unwrap_or(config.max_output_tokens);
    Ok(Some(ResolvedTurnModel {
        provider_id: config.id.clone(),
        model: config.model.clone(),
        temperature,
        max_output_tokens: u32::try_from(max_output_tokens).unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS),
        context_window: u32::try_from(config.context_window).unwrap_or(DEFAULT_CONTEXT_WINDOW),
        thinking_enabled: Some(reasoning.enabled),
        thinking_budget_tokens: reasoning.budget_tokens.filter(|n| *n > 0),
        provider_config: snapshot(&config),
        compaction_provider_config: None,
    }))
}

/// Cursor and Antigravity put the effort in the id; the body field would be
/// a control that looks connected and is not.
fn drop_reasoning_effort(config: &mut WindowConfig) {
    if let Some(params) = config.custom_params.as_mut() {
        if params.contains_key("reasoning_effort") {
            params.remove("reasoning_effort");
            if params.is_empty() {
                config.custom_params = None;
            }
        }
    }
}

/// `buildProviderConfigSnapshot`: a pool only when it holds more than one
/// real key. Header values are strings on the wire; anything else would have
/// failed the request's own deserialisation.
fn snapshot(config: &WindowConfig) -> ProviderConfigSnapshot {
    ProviderConfigSnapshot {
        provider_id: config.id.clone(),
        provider_type: Some(config.provider_type.clone()),
        base_url: config.base_url.clone(),
        api_key: config.api_key.clone(),
        api_keys: config
            .api_keys
            .as_ref()
            .map(|keys| keys.iter().filter(|k| !k.trim().is_empty()).cloned().collect::<Vec<_>>())
            .filter(|keys| keys.len() > 1),
        model: config.model.clone(),
        custom_headers: config.custom_headers.as_ref().and_then(Value::as_object).map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| value.as_str().map(|s| (name.clone(), s.to_string())))
                .collect()
        }),
        custom_params: config
            .custom_params
            .as_ref()
            .map(|params| params.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<HashMap<_, _>>()),
        default_temperature: config.default_temperature.map(|t| t as f32),
        default_max_tokens: config.default_max_tokens.and_then(|n| u32::try_from(n).ok()),
        supports_thinking: config.supports_thinking,
        reasoning: config.reasoning.clone(),
        supports_vision: config.supports_vision,
        tool_images_in_result: config.tool_images_in_result,
    }
}

// ── Provider-specific id rules ───────────────────────────────────────────────

/// `antigravityWireModel`: the effort tier is part of the id.
fn antigravity_wire_model(model: &ProviderModel) -> Option<String> {
    const LEVELS: [&str; 3] = ["low", "medium", "high"];
    let reasoning = model.reasoning.as_ref()?.as_object()?;
    if reasoning.get("type").and_then(Value::as_str) != Some("effort") {
        return None;
    }
    let levels: Vec<&str> = reasoning.get("levels")?.as_array()?.iter().filter_map(Value::as_str).collect();
    if levels.is_empty() || !levels.iter().all(|level| LEVELS.contains(level)) {
        return None;
    }
    let level = reasoning
        .get("default")
        .and_then(Value::as_str)
        .filter(|d| levels.contains(d))
        .unwrap_or(levels[levels.len() - 1]);
    Some(format!("{}-{level}", model.model_key))
}

/// `OPENCODE_MODEL_WIRES` + `defaultOpenCodeWire` + `openCodeWireFor`.
fn opencode_wire_for(model_key: &str, chosen: Option<&str>) -> &'static str {
    const KNOWN: &[(&str, &str)] = &[
        ("grok-4.5", "opencode-go"),
        ("gpt-5.6-luna", "opencode-go"),
        ("muse-spark-1.2-contributor", "opencode-go"),
        ("minimax-m3", "opencode-go-messages"),
        ("minimax-m2.7", "opencode-go-messages"),
        ("minimax-m2.5", "opencode-go-messages"),
        ("qwen3.8-max", "opencode-go-messages"),
        ("qwen3.7-max", "opencode-go-messages"),
        ("qwen3.7-plus", "opencode-go-messages"),
        ("qwen3.6-plus", "opencode-go-messages"),
        ("glm-5.3", "opencode-go-chat"),
        ("glm-5.2", "opencode-go-chat"),
        ("glm-5.1", "opencode-go-chat"),
        ("kimi-k3", "opencode-go-chat"),
        ("kimi-k2.7-code", "opencode-go-chat"),
        ("kimi-k2.6", "opencode-go-chat"),
        ("deepseek-v4-pro", "opencode-go-chat"),
        ("deepseek-v4-flash", "opencode-go-chat"),
        ("deepseek-v4-flash-vision-exp", "opencode-go-chat"),
        ("mimo-v2.5", "opencode-go-chat"),
        ("mimo-v2.5-pro", "opencode-go-chat"),
        ("hy3", "opencode-go-chat"),
        ("ox-alpha-free", "opencode-go-chat"),
    ];
    match chosen {
        Some(wire @ ("opencode-go" | "opencode-go-chat" | "opencode-go-messages")) => {
            return match wire {
                "opencode-go" => "opencode-go",
                "opencode-go-chat" => "opencode-go-chat",
                _ => "opencode-go-messages",
            };
        }
        _ => {}
    }
    let id = model_key.trim().to_lowercase();
    let id = id.strip_suffix("-free").unwrap_or(&id);
    if let Some((_, wire)) = KNOWN.iter().find(|(known, _)| *known == id) {
        return wire;
    }
    if id.starts_with("qwen") || id.starts_with("minimax") {
        "opencode-go-messages"
    } else if id.starts_with("gpt") || id.starts_with("grok") || id.starts_with("muse") {
        "opencode-go"
    } else {
        "opencode-go-chat"
    }
}

/// `cursor-variants.ts` + `cursor-run.ts`: the one wire id for a row's
/// controls, checked against the account's catalogue.
mod cursor {
    use super::ProviderModel;
    use serde_json::Value;

    /// `MODIFIERS`, longest first as the window sorts them (a stable sort,
    /// so equal lengths keep their order).
    const MODIFIERS: [&str; 10] =
        ["thinking", "minimal", "medium", "xhigh", "extra", "high", "none", "fast", "low", "max"];

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) struct Parts {
        pub stem: String,
        pub thinking: bool,
        pub effort: Option<String>,
        pub fast: bool,
    }

    /// `splitCursorVariant`: strip modifiers in a loop, whichever order
    /// Cursor wrote them; the first effort seen (the outermost) wins.
    pub(super) fn split(model_id: &str) -> Parts {
        let mut stem = model_id.to_string();
        let mut parts = Parts { stem: String::new(), thinking: false, effort: None, fast: false };
        loop {
            let before = stem.len();
            for modifier in MODIFIERS {
                let suffix = format!("-{modifier}");
                if !stem.to_lowercase().ends_with(&suffix) {
                    continue;
                }
                stem.truncate(stem.len() - suffix.len());
                match modifier {
                    "thinking" => parts.thinking = true,
                    "fast" => parts.fast = true,
                    _ if parts.effort.is_none() => parts.effort = Some(modifier.to_string()),
                    _ => {}
                }
                break;
            }
            if stem.len() == before {
                break;
            }
        }
        parts.stem = stem;
        parts
    }

    /// `reasoningIsOn`.
    fn reasoning_is_on(reasoning: &Value) -> bool {
        if reasoning.get("toggleable") == Some(&Value::Bool(false)) {
            return true;
        }
        if let Some(enabled) = reasoning.get("enabled").and_then(Value::as_bool) {
            return enabled;
        }
        if reasoning.get("type").and_then(Value::as_str) == Some("toggle") {
            return reasoning.get("default") != Some(&Value::Bool(false));
        }
        true
    }

    /// `resolveCursorModelRun`: the row's controls as one run, resolved to
    /// an id the account carries. Errors carry the window's own messages.
    pub(super) fn resolve_run(
        catalogue: &[String],
        model: Option<&ProviderModel>,
        config_model: &str,
        fast_preference: Option<bool>,
    ) -> Result<String, String> {
        let model_key = model.map(|m| m.model_key.as_str()).unwrap_or(config_model);
        let own = split(model_key);
        let variants: Vec<Parts> = catalogue
            .iter()
            .map(|id| split(id))
            .filter(|parts| parts.stem == own.stem)
            .collect();
        let catalogue_empty = catalogue.is_empty();
        let reasoning = model.and_then(|m| m.reasoning.as_ref());
        // `cursorRunOptions`: Fast is the row's preference when there is a
        // row, else what the id says.
        let fast = match model {
            Some(_) => fast_preference.unwrap_or(false),
            None => own.fast,
        };
        let has_thinking = variants.iter().any(|v| v.thinking);
        let thinking_only = has_thinking && variants.iter().all(|v| v.thinking);
        let thinking = if !variants.is_empty() && has_thinking {
            thinking_only || reasoning.map_or(own.thinking, reasoning_is_on)
        } else {
            own.thinking
        };
        let effort = match reasoning {
            Some(r) if r.get("type").and_then(Value::as_str) == Some("effort") => {
                r.get("default").and_then(Value::as_str).map(str::to_string).or(own.effort.clone())
            }
            _ => own.effort.clone(),
        };
        if variants.is_empty() {
            return Err(if catalogue_empty {
                "Cursor's model catalogue is not ready. Reload Cursor models in Settings, then try again.".into()
            } else {
                format!(
                    "Cursor no longer offers {}. Reload its model catalogue and choose an available model.",
                    own.stem
                )
            });
        }
        let found = catalogue
            .iter()
            .map(|id| (id, split(id)))
            .find(|(_, parts)| parts.stem == own.stem && parts.thinking == thinking && parts.effort == effort && parts.fast == fast);
        match found {
            Some((id, _)) => Ok(id.clone()),
            None => {
                let choices: Vec<String> = [
                    thinking.then(|| "thinking".to_string()),
                    effort.as_ref().map(|e| format!("{e} effort")),
                    fast.then(|| "Fast".to_string()),
                ]
                .into_iter()
                .flatten()
                .collect();
                let run = if choices.is_empty() { "the selected settings".to_string() } else { choices.join(", ") };
                Err(format!(
                    "Cursor does not offer {} with {run}. Change the model settings and try again.",
                    own.stem
                ))
            }
        }
    }
}

// ── Shadow ───────────────────────────────────────────────────────────────────

/// Every field where the engine's resolution differs from the request's,
/// one line each. Key material is never printed: those lines say only that
/// the value differs.
#[must_use]
pub fn shadow_model_diff(request: &AgentChatRequest, engine: &ResolvedTurnModel) -> Vec<String> {
    let mut lines = Vec::new();
    let mut check = |name: &str, client: Value, engine: Value| {
        if client != engine {
            lines.push(format!("{name}: client {client} / engine {engine}"));
        }
    };
    check("providerId", Value::from(request.provider_id.as_str()), Value::from(engine.provider_id.as_str()));
    check("model", Value::from(request.model.as_str()), Value::from(engine.model.as_str()));
    // An `f32` widened for printing shows its binary tail (`0.8999999761581421`);
    // six decimals is more than any temperature carries.
    let shown = |t: Option<f32>| serde_json::to_value(t.map(|t| (f64::from(t) * 1e6).round() / 1e6)).unwrap_or_default();
    check("temperature", shown(request.temperature), shown(engine.temperature));
    check("maxOutputTokens", serde_json::to_value(request.max_output_tokens).unwrap_or_default(), Value::from(engine.max_output_tokens));
    check("contextWindow", serde_json::to_value(request.context_window).unwrap_or_default(), Value::from(engine.context_window));
    check("thinkingEnabled", serde_json::to_value(request.thinking_enabled).unwrap_or_default(), serde_json::to_value(engine.thinking_enabled).unwrap_or_default());
    check("thinkingBudgetTokens", serde_json::to_value(request.thinking_budget_tokens).unwrap_or_default(), serde_json::to_value(engine.thinking_budget_tokens).unwrap_or_default());
    lines.extend(snapshot_diff("providerConfig", Some(&request.provider_config), Some(&engine.provider_config)));
    lines.extend(snapshot_diff(
        "compactionProviderConfig",
        request.compaction_provider_config.as_ref(),
        engine.compaction_provider_config.as_ref(),
    ));
    lines
}

fn snapshot_diff(name: &str, client: Option<&ProviderConfigSnapshot>, engine: Option<&ProviderConfigSnapshot>) -> Vec<String> {
    const SECRET: [&str; 2] = ["apiKey", "apiKeys"];
    let (client, engine) = match (client, engine) {
        (None, None) => return Vec::new(),
        (Some(c), Some(e)) => (c, e),
        (c, e) => {
            return vec![format!(
                "{name}: client {} / engine {}",
                if c.is_some() { "set" } else { "none" },
                if e.is_some() { "set" } else { "none" }
            )]
        }
    };
    let (client, engine) = (
        serde_json::to_value(client).unwrap_or_default(),
        serde_json::to_value(engine).unwrap_or_default(),
    );
    let (Some(client), Some(engine)) = (client.as_object(), engine.as_object()) else {
        return vec![format!("{name}: not comparable")];
    };
    let mut keys: Vec<&String> = client.keys().chain(engine.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|key| client.get(*key) != engine.get(*key))
        .map(|key| {
            if SECRET.contains(&key.as_str()) {
                format!("{name}.{key}: differs")
            } else {
                format!(
                    "{name}.{key}: client {} / engine {}",
                    client.get(key).unwrap_or(&Value::Null),
                    engine.get(key).unwrap_or(&Value::Null)
                )
            }
        })
        .collect()
}

/// Log the shadow comparison of one turn's model resolution (`aurora.log`,
/// `turn_build`). The provider snapshot decides the wire and the cached
/// prefix, so any difference here matters as much as one in the prompt.
pub fn report_shadow_model(thread_id: &str, request: &AgentChatRequest, engine: &ResolvedTurnModel) {
    let lines = shadow_model_diff(request, engine);
    if lines.is_empty() {
        crate::logging::log_info(
            "turn_build",
            &format!("shadow model for {thread_id}: identical ({} → {})", request.model_selection.as_deref().unwrap_or("?"), engine.model),
        );
    } else {
        crate::logging::log_warn(
            "turn_build",
            &format!("shadow model for {thread_id}: DIFFERS in {} field(s)\n  {}", lines.len(), lines.join("\n  ")),
        );
    }
}

/// Put the engine's resolution on the request, in place of the client's.
pub fn apply(request: &mut AgentChatRequest, resolved: ResolvedTurnModel) {
    request.provider_id = resolved.provider_id;
    request.model = resolved.model;
    request.provider_config = resolved.provider_config;
    request.temperature = resolved.temperature;
    request.max_output_tokens = Some(resolved.max_output_tokens);
    request.context_window = Some(resolved.context_window);
    request.thinking_enabled = resolved.thinking_enabled;
    request.thinking_budget_tokens = resolved.thinking_budget_tokens;
    request.compaction_provider_config = resolved.compaction_provider_config;
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_DIR: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_runtime/turn_build/golden/provider");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenCase {
        name: String,
        selection: String,
        thinking_preference: bool,
        compaction_model: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Golden {
        providers: Vec<LLMProvider>,
        models: Vec<ProviderModel>,
        cursor_catalogue: Vec<String>,
        cursor_fast: HashMap<String, bool>,
        selected_model: String,
        cases: Vec<GoldenCase>,
    }

    fn golden() -> Golden {
        let raw = std::fs::read_to_string(format!("{GOLDEN_DIR}/cases.json"))
            .expect("golden cases.json (written by agent-provider.golden.test.ts)");
        serde_json::from_str(&raw).expect("cases.json parses as the engine's row types")
    }

    /// The engine resolves, for every case the window recorded, the same
    /// request slice, or refuses with the same message.
    #[test]
    fn resolves_the_same_slice_the_window_did() {
        let golden = golden();
        assert!(golden.cases.len() >= 24, "only {} cases", golden.cases.len());
        let rows = ProviderRows {
            providers: golden.providers,
            models: golden.models,
            cursor_catalogue: golden.cursor_catalogue,
        };
        for case in golden.cases {
            let expected: Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{GOLDEN_DIR}/{}.json", case.name))
                    .unwrap_or_else(|e| panic!("golden {}: {e}", case.name)),
            )
            .unwrap();
            // The window's Fast preference for the row the selection resolves to.
            let (provider_id, model_key) = case.selection.split_once(':').unwrap_or((&case.selection, ""));
            let facts = EngineModelFacts {
                cursor_fast: find_model(&rows, provider_id, model_key)
                    .map(|m| golden.cursor_fast.get(&m.id).copied().unwrap_or(false)),
            };
            let result = resolve_turn_model(
                &rows,
                TurnModelInputs {
                    selection: &case.selection,
                    selected_model: &golden.selected_model,
                    compaction_model: &case.compaction_model,
                    thinking_preference: case.thinking_preference,
                    facts: &facts,
                },
            );
            match (expected.get("error").and_then(Value::as_str), result) {
                (Some(message), Err(error)) => assert_eq!(error, message, "case {}", case.name),
                (Some("unresolved"), Ok(None)) => {}
                (Some(message), Ok(other)) => {
                    panic!("case {}: window refused with {message:?}, engine resolved {other:?}", case.name)
                }
                (None, Ok(Some(engine))) => {
                    // Through the engine's own types, so the two keys the
                    // window adds to its snapshot and Rust ignores
                    // (`contextWindow`, `maxOutputTokens` inside it) drop out.
                    let window: ResolvedTurnModel =
                        serde_json::from_value(expected).unwrap_or_else(|e| panic!("case {}: {e}", case.name));
                    assert_eq!(
                        serde_json::to_value(&engine).unwrap(),
                        serde_json::to_value(&window).unwrap(),
                        "case {}",
                        case.name
                    );
                }
                (None, other) => panic!("case {}: window resolved, engine gave {other:?}", case.name),
            }
        }
    }

    #[test]
    fn a_cursor_id_splits_whichever_way_it_was_written() {
        let a = cursor::split("claude-opus-5-thinking-high");
        let b = cursor::split("claude-4.5-opus-high-thinking");
        assert_eq!((a.stem.as_str(), a.thinking, a.effort.as_deref(), a.fast), ("claude-opus-5", true, Some("high"), false));
        assert_eq!((b.stem.as_str(), b.thinking, b.effort.as_deref()), ("claude-4.5-opus", true, Some("high")));
        let c = cursor::split("cursor-grok-4.6-xhigh-fast");
        assert_eq!((c.stem.as_str(), c.effort.as_deref(), c.fast), ("cursor-grok-4.6", Some("xhigh"), true));
        assert_eq!(cursor::split("composer-2").effort, None);
    }

    #[test]
    fn an_opencode_wire_follows_the_override_then_the_table_then_the_prefix() {
        assert_eq!(opencode_wire_for("glm-5.3", Some("opencode-go")), "opencode-go");
        assert_eq!(opencode_wire_for("Kimi-K3", None), "opencode-go-chat");
        assert_eq!(opencode_wire_for("qwen3.9-max-free", None), "opencode-go-messages");
        assert_eq!(opencode_wire_for("grok-5", None), "opencode-go");
        assert_eq!(opencode_wire_for("something-new", Some("openai")), "opencode-go-chat");
    }

    #[test]
    fn a_differing_snapshot_names_the_field_but_never_a_key() {
        let golden = golden();
        let rows = ProviderRows { providers: golden.providers, models: golden.models, cursor_catalogue: vec![] };
        let facts = EngineModelFacts::default();
        let engine = resolve_turn_model(
            &rows,
            TurnModelInputs { selection: "oa:gpt-4o", selected_model: "", compaction_model: "", thinking_preference: true, facts: &facts },
        )
        .unwrap()
        .unwrap();
        let mut request: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "turnId": "t", "threadId": "th", "userMessage": "hi", "providerId": "", "model": "",
            "providerConfig": { "baseUrl": "" }, "tools": []
        }))
        .expect("a minimal request");
        apply(&mut request, engine.clone());
        assert!(shadow_model_diff(&request, &engine).is_empty());
        request.provider_config.api_key = "other".into();
        request.temperature = Some(0.9);
        let lines = shadow_model_diff(&request, &engine);
        assert_eq!(lines, vec!["temperature: client 0.9 / engine 0.2".to_string(), "providerConfig.apiKey: differs".to_string()]);
    }
}
