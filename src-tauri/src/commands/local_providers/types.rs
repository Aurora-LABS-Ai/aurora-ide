use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalProvider {
    pub r#type: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<LocalModel>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
    pub size_bytes: Option<u64>,
    pub parameter_size: Option<String>,
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub quantization: Option<String>,
    pub format: Option<String>,
    pub max_context_length: Option<u32>,
    pub trained_for_tool_use: Option<bool>,
    pub vision: Option<bool>,
    pub supports_thinking: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub providers: Vec<LocalProvider>,
    pub best_provider: Option<LocalProvider>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelInfo {
    pub license: Option<String>,
    pub parameters: Option<String>,
    pub template: Option<String>,
    pub system: Option<String>,
    pub details: OllamaModelDetails,
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelDetails {
    pub parent_model: Option<String>,
    pub format: Option<String>,
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRunningModel {
    pub name: String,
    pub model: String,
    pub size: u64,
    pub size_vram: u64,
    pub context_length: u32,
    pub expires_at: String,
    pub details: OllamaModelDetails,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaTagsResponse {
    pub(crate) models: Option<Vec<OllamaTagModel>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaTagModel {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) details: Option<OllamaTagModelDetails>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaTagModelDetails {
    pub(crate) parameter_size: Option<String>,
    pub(crate) family: Option<String>,
    pub(crate) families: Option<Vec<String>>,
    pub(crate) format: Option<String>,
    pub(crate) quantization_level: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaVersionResponse {
    pub(crate) version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LmStudioModelsResponse {
    pub(crate) data: Option<Vec<LmStudioModel>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LmStudioModel {
    pub(crate) id: String,
    pub(crate) display_name: Option<String>,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) params_string: Option<String>,
    pub(crate) architecture: Option<String>,
    pub(crate) vision: Option<bool>,
    pub(crate) trained_for_tool_use: Option<bool>,
    pub(crate) max_context_length: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaRunningModelsResponse {
    pub(crate) models: Option<Vec<OllamaRunningModelWire>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaRunningModelWire {
    pub(crate) name: String,
    pub(crate) model: String,
    pub(crate) size: u64,
    pub(crate) size_vram: Option<u64>,
    pub(crate) context_length: Option<u32>,
    pub(crate) expires_at: Option<String>,
    pub(crate) details: Option<OllamaModelDetails>,
}
