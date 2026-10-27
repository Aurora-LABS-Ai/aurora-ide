//! Resolve stored per-model request settings for backend-owned conversations.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::agent_runtime::api_client::{
    ReasoningConfig, ReasoningControl, ReasoningReplayMode, ReasoningRequestMode,
};
use crate::db::{LLMProvider, ProviderModel};

use super::ProviderConfigSnapshot;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningProfile {
    #[serde(rename = "type")]
    control: ReasoningControl,
    enabled: Option<bool>,
    toggleable: Option<bool>,
    #[serde(rename = "default")]
    default_value: Option<Value>,
    #[serde(default)]
    request_mode: ReasoningRequestMode,
    replay: Option<ReasoningReplayMode>,
}

fn legacy_replay(extra: Option<&Value>) -> ReasoningReplayMode {
    match extra.and_then(|v| v.get("reasoning_replay")) {
        Some(Value::Bool(false)) => ReasoningReplayMode::Off,
        Some(Value::String(value)) => match value.trim().to_ascii_lowercase().as_str() {
            "reasoning_content" => ReasoningReplayMode::ReasoningContent,
            "reasoning" => ReasoningReplayMode::Reasoning,
            "off" | "none" | "drop" | "false" => ReasoningReplayMode::Off,
            _ => ReasoningReplayMode::Auto,
        },
        _ => ReasoningReplayMode::Auto,
    }
}

/// The typed reasoning request for one model row (`resolveModelRequestKnobs`
/// in the window; the shared fixtures below prove the two equal). Also the
/// engine's own turn resolution, `agent_runtime::turn_build::provider`.
pub(crate) fn reasoning_for(
    model: &ProviderModel,
    thinking_preference: bool,
) -> Result<ReasoningConfig, String> {
    let mut reasoning = ReasoningConfig {
        enabled: model.supports_thinking && thinking_preference,
        control: if model.supports_thinking {
            ReasoningControl::Toggle
        } else {
            ReasoningControl::None
        },
        replay: legacy_replay(model.extra_body.as_ref()),
        ..Default::default()
    };
    let Some(profile) = model.reasoning.as_ref() else {
        return Ok(reasoning);
    };
    let profile: ReasoningProfile = serde_json::from_value(profile.clone()).map_err(|e| {
        format!(
            "model {:?} has invalid reasoning settings: {e}",
            model.model_key
        )
    })?;
    let on = profile.toggleable == Some(false)
        || profile.enabled.unwrap_or_else(|| {
            profile.control != ReasoningControl::Toggle
                || profile.default_value != Some(Value::Bool(false))
        });
    reasoning.enabled = model.supports_thinking && on;
    reasoning.control = profile.control;
    reasoning.request_mode = profile.request_mode;
    reasoning.replay = profile.replay.unwrap_or(reasoning.replay);
    if on {
        match profile.control {
            ReasoningControl::Effort => {
                reasoning.effort = profile.default_value.and_then(|value| match value {
                    Value::String(s) if !s.is_empty() => Some(s),
                    Value::Number(n) if n.as_f64() != Some(0.0) => Some(n.to_string()),
                    Value::Bool(true) => Some("true".into()),
                    _ => None,
                });
            }
            ReasoningControl::Budget => {
                reasoning.budget_tokens = profile
                    .default_value
                    .as_ref()
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
            }
            _ => {}
        }
    }
    Ok(reasoning)
}

fn wire_for(provider: &LLMProvider, model: &ProviderModel) -> Option<String> {
    if provider.id != "opencode-go" {
        return model
            .provider_type
            .clone()
            .or_else(|| provider.provider_type.clone());
    }
    if let Some(chosen) = model.provider_type.as_deref().filter(|kind| {
        matches!(
            *kind,
            "opencode-go" | "opencode-go-chat" | "opencode-go-messages"
        )
    }) {
        return Some(chosen.to_string());
    }
    let key = model.model_key.trim().to_ascii_lowercase();
    let key = key.strip_suffix("-free").unwrap_or(&key);
    let wire = if ["qwen", "minimax"]
        .iter()
        .any(|prefix| key.starts_with(prefix))
    {
        "opencode-go-messages"
    } else if ["gpt", "grok", "muse"]
        .iter()
        .any(|prefix| key.starts_with(prefix))
    {
        "opencode-go"
    } else {
        "opencode-go-chat"
    };
    Some(wire.to_string())
}

pub(crate) fn resolve(
    provider: &LLMProvider,
    model: &ProviderModel,
    thinking_preference: bool,
) -> Result<ProviderConfigSnapshot, String> {
    let api_keys = provider
        .api_keys
        .as_ref()
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|keys| !keys.is_empty());
    let custom_headers = provider
        .custom_headers
        .as_ref()
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| value.as_str().map(|s| (name.clone(), s.to_string())))
                .collect()
        });
    let mut custom_params: HashMap<String, Value> = provider
        .custom_params
        .as_ref()
        .and_then(Value::as_object)
        .map(|fields| fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    if let Some(extra) = model.extra_body.as_ref() {
        let fields = extra.as_object().ok_or_else(|| {
            format!(
                "model {:?}'s extra request fields must be an object",
                model.model_key
            )
        })?;
        custom_params.extend(
            fields
                .iter()
                .filter(|(key, _)| key.as_str() != "reasoning_replay")
                .map(|(k, v)| (k.clone(), v.clone())),
        );
    }
    custom_params.remove("reasoning_replay");
    Ok(ProviderConfigSnapshot {
        provider_id: provider.id.clone(),
        provider_type: wire_for(provider, model),
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        api_keys,
        model: model.model_key.clone(),
        custom_headers,
        custom_params: (!custom_params.is_empty()).then_some(custom_params),
        default_temperature: model
            .temperature
            .or(provider.default_temperature)
            .map(|t| t as f32),
        default_max_tokens: provider
            .default_max_tokens
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0),
        supports_thinking: model.supports_thinking,
        reasoning: Some(reasoning_for(model, thinking_preference)?),
        supports_vision: model.supports_vision,
        tool_images_in_result: provider.tool_images_in_result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_matches_the_frontend_on_shared_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/kernel/services/providers/model-request-fixtures.json")).unwrap();
        for case in cases {
            let model: ProviderModel = serde_json::from_value(serde_json::json!({
                "id": "p::m", "providerId": "p", "modelKey": "m",
                "supportsThinking": case["supportsThinking"],
                "reasoning": case.get("reasoning"), "extraBody": case.get("extraBody")
            }))
            .unwrap();
            let resolved =
                reasoning_for(&model, case["thinkingPreference"].as_bool().unwrap()).unwrap();
            assert_eq!(
                serde_json::to_value(resolved).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }
}
