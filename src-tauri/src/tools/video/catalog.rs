//! The native video catalog shared by provider settings and the chat tool.
//!
//! One roster for both services. The frontend does not keep a second copy, and
//! the tool schema's `model` enum is generated from [`all_models`] so a model
//! can never be offered in settings while the tool refuses it.
use super::{qwen, wire};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCatalog {
    pub models: Vec<VideoModel>,
    pub default_model: &'static str,
}

#[derive(Serialize)]
pub struct VideoModel {
    pub model: &'static str,
    pub label: &'static str,
    /// Which service serves it. Rows are grouped by this in settings.
    pub vendor: &'static str,
    pub api: &'static str,
    pub access: &'static str,
    pub input: &'static str,
    pub duration: Vec<u8>,
    pub resolutions: &'static [&'static str],
    pub note: &'static str,
}

/// Every model name the tool accepts, in catalogue order.
pub fn all_models() -> Vec<&'static str> {
    wire::MODELS.iter().chain(qwen::MODELS).copied().collect()
}

pub fn catalog() -> VideoCatalog {
    VideoCatalog {
        default_model: wire::MODELS[0],
        models: vec![
            VideoModel {
                model: wire::MODELS[0],
                label: "Hailuo 2.3",
                vendor: "MiniMax",
                api: "v1",
                access: "Subscription Key or pay-as-you-go API key",
                input: "Text or first frame",
                duration: vec![6, 10],
                resolutions: &["768P", "1080P"],
                note: "1080P: 6s only",
            },
            VideoModel {
                model: wire::MODELS[1],
                label: "Hailuo 2.3 Fast",
                vendor: "MiniMax",
                api: "v1",
                access: "Account eligibility required",
                input: "First frame required",
                duration: vec![6, 10],
                resolutions: &["768P", "1080P"],
                note: "1080P: 6s only",
            },
            VideoModel {
                model: wire::MODELS[2],
                label: "H3",
                vendor: "MiniMax",
                api: "v2",
                access: "Pay-as-you-go",
                input: "Text, frames or references",
                duration: (4..=15).collect(),
                resolutions: &["768P", "2K"],
                note: "Frames and references cannot be combined",
            },
            VideoModel {
                model: wire::MODELS[3],
                label: "H3 Max",
                vendor: "MiniMax",
                api: "v2",
                access: "Pay-as-you-go",
                input: "Text, frames or references",
                duration: (5..=15).collect(),
                resolutions: &["480P", "768P"],
                note: "Frames and references cannot be combined",
            },
            VideoModel {
                model: qwen::MODELS[0],
                label: "Wan 3.0",
                vendor: "Qwen",
                api: "async task",
                access: "Pay-as-you-go",
                input: "Text, frames or references",
                duration: (2..=30).collect(),
                resolutions: qwen::RESOLUTIONS,
                note: "Defaults to 720P; 1080P costs more",
            },
            VideoModel {
                model: qwen::MODELS[1],
                label: "Wan 3.0 Prime",
                vendor: "Qwen",
                api: "async task",
                access: "Pay-as-you-go",
                input: "Text, frames or references",
                duration: (2..=30).collect(),
                resolutions: qwen::RESOLUTIONS,
                note: "High-speed variant of Wan 3.0",
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolExecutor;

    #[test]
    fn settings_catalog_matches_the_tool_schema_and_request_validator() {
        let catalog = catalog();
        let schema = super::super::VideoTool.schema();
        let ids: Vec<_> = catalog.models.iter().map(|m| m.model).collect();
        assert_eq!(ids, all_models());
        assert_eq!(
            schema.input_schema["properties"]["model"]["enum"],
            serde_json::json!(ids)
        );
        assert_eq!(catalog.default_model, wire::VideoRequest::default().model());
        // Every catalogued combination has to pass the validator that guards
        // the spend, and each row must resolve to the service that owns it.
        for model in catalog.models {
            assert_eq!(
                super::super::Vendor::of_model(model.model),
                Some(match model.vendor {
                    "Qwen" => super::super::Vendor::Qwen,
                    _ => super::super::Vendor::MiniMax,
                })
            );
            for duration in &model.duration {
                for resolution in model.resolutions {
                    let request = wire::VideoRequest {
                        prompt: "A sunrise".into(),
                        model: Some(model.model.into()),
                        duration: Some(*duration),
                        resolution: Some((*resolution).into()),
                        first_frame: (model.model == wire::MODELS[1])
                            .then(|| "https://example.com/frame.png".into()),
                        ..Default::default()
                    };
                    if model.vendor == "Qwen" {
                        qwen::validate(&request).unwrap();
                        continue;
                    }
                    assert_eq!(request.v2(), model.api == "v2");
                    let restricted = *duration == 10 && *resolution == "1080P";
                    assert_eq!(request.validate().is_ok(), !restricted);
                    if restricted {
                        assert_eq!(model.note, "1080P: 6s only");
                    }
                }
            }
        }
    }

    #[test]
    fn catalog_preserves_access_requirements_without_claiming_verified_quota() {
        let catalog = catalog();
        assert!(catalog.models[0].access.contains("Subscription Key"));
        assert_eq!(catalog.models[1].input, "First frame required");
        assert_eq!(catalog.models[1].access, "Account eligibility required");
        for model in &catalog.models[2..] {
            assert_eq!(model.access, "Pay-as-you-go");
        }
        // The catalogue reports what is CONFIGURED, never a verified balance,
        // and it must not imply Aurora picked the expensive tier for anyone.
        let qwen_rows: Vec<_> = catalog
            .models
            .iter()
            .filter(|m| m.vendor == "Qwen")
            .collect();
        assert_eq!(qwen_rows.len(), qwen::MODELS.len());
        assert!(qwen_rows[0].note.contains("720P"));
        let value = serde_json::to_value(catalog).unwrap();
        assert_eq!(value["defaultModel"], wire::MODELS[0]);
        assert!(value.get("apiKey").is_none());
        assert!(value.get("quota").is_none());
    }
}
