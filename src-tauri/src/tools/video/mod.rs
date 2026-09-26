//! Chat-only native MiniMax video generation, with durable tasks and explicit queries.
pub mod catalog;
pub mod jobs;
pub mod qwen;
#[cfg(test)]
mod tests;
pub mod wire;
use crate::agent_runtime::{
    api_client::ToolSchema,
    tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry},
};
use crate::tools::image::config::{self, ImageApiFormat, ImageProviderConfig};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOL_NAMES: &[&str] = &["generate_video"];
pub fn register(registry: &mut ToolRegistry) {
    registry.register(Arc::new(VideoTool));
}
pub struct VideoTool;

/// Which video service a provider row speaks. Video is a separate contract
/// from images even on the same account, so this is derived from the row's
/// image format rather than stored twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vendor {
    MiniMax,
    Qwen,
}

impl Vendor {
    /// `None` for a row whose provider publishes no video API at all.
    #[must_use]
    pub const fn of(format: ImageApiFormat) -> Option<Self> {
        match format {
            ImageApiFormat::MiniMax => Some(Self::MiniMax),
            ImageApiFormat::Qwen => Some(Self::Qwen),
            _ => None,
        }
    }

    /// The service that owns a model name. Model names are the one thing a
    /// caller always supplies, and the two rosters do not overlap.
    #[must_use]
    pub fn of_model(model: &str) -> Option<Self> {
        if qwen::MODELS.contains(&model) {
            Some(Self::Qwen)
        } else if wire::MODELS.contains(&model) {
            Some(Self::MiniMax)
        } else {
            None
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::MiniMax => "MiniMax",
            Self::Qwen => "Qwen",
        }
    }
}

/// The row to generate with.
///
/// `model` decides the service, because asking Qwen for a Hailuo model is a
/// wasted round trip and a confusing refusal. `id` narrows further when the
/// user keeps several rows for one service.
pub fn provider<'a>(
    providers: &'a [ImageProviderConfig],
    id: Option<&str>,
    model: Option<&str>,
) -> Result<&'a ImageProviderConfig, String> {
    let wanted = match model {
        Some(model) => Some(Vendor::of_model(model).ok_or_else(|| {
            format!("Unknown video model '{model}'; use op 'list' for supported models")
        })?),
        None => None,
    };
    providers
        .iter()
        .find(|p| {
            Vendor::of(p.api_format).is_some_and(|v| wanted.is_none_or(|w| v == w))
                && p.ready()
                && id.is_none_or(|id| p.is_named(id.trim()))
        })
        .ok_or_else(|| match wanted {
            Some(Vendor::Qwen) => "No ready Qwen provider. Add your DashScope API key under Settings > Providers > Image providers > Qwen. Wan 3.0 video is pay-as-you-go.".into(),
            Some(Vendor::MiniMax) => "No ready MiniMax native provider. Add your Subscription Key under Settings > Providers > Image providers > MiniMax. H3 needs pay-as-you-go access; Hailuo 2.3 is the subscription model.".into(),
            None => "No ready video provider. Add a MiniMax or Qwen key under Settings > Providers > Image providers.".into(),
        })
}
#[async_trait]
impl ToolExecutor for VideoTool {
    fn name(&self) -> &str {
        "generate_video"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema { name:self.name().into(),description:"Generate a video with native MiniMax or Qwen (Wan 3.0), list available video models, or check a saved task. Chat only. The model name decides the service and the two rosters do not overlap; Wan 3.0 models need a Qwen/DashScope key, MiniMax models need a MiniMax key. op='list' is read-only and reports configuration, not verified quota. op='generate' creates ONE billed task and returns a durable jobId; default MiniMax-Hailuo-2.3 uses the subscription-compatible v1 API (6s, 768P). Never silently switch to H3: H3/H3-Max use pay-as-you-go v2. op='query' with jobId checks progress and saves completed MP4 locally; query again later rather than generating again. A timeout during submission is ambiguous: do not automatically resubmit. First/last/reference images may name a conversation asset, its position, or a public HTTP(S) URL. Hailuo 2.3 supports text or first frame only; Fast requires first frame. H3 supports text, first/last frames or references, never frames mixed with references. H3 references: up to 9 images, 3 videos and 3 audio clips; video/audio must be public URLs or mm_file:// ids, 2-15s each and at most 15s total per kind. H3 reference images 256-5760px, ratio 0.4-2.5, at most 30MB; Hailuo images short edge >300px, ratio 0.4-2.5, under 20MB. Local images are validated; MiniMax validates remote media. Do not invent source URLs or claim to have watched generated video.".into(),input_schema:json!({"type":"object","properties":{
            "op":{"type":"string","enum":["list","generate","query"],"default":"generate"},
            "provider":{"type":"string","description":"The video provider to call, by the id or name op='list' shows. Pass it whenever the user names one; queries use the saved provider."},
            "jobId":{"type":"string","description":"Saved job id for op=query."},
            "prompt":{"type":"string","description":"Required for generate. Up to 2000 characters for Hailuo, 7000 for H3."},
            "model":{"type":"string","enum":catalog::all_models(),"default":"MiniMax-Hailuo-2.3"},
            "duration":{"type":"integer","description":"Hailuo 6 or 10s (1080P only 6s); H3 4-15s; H3-Max 5-15s; Wan 3.0 2-30s (default 5)."},
            "resolution":{"type":"string","enum":["480P","720P","768P","1080P","2K"],"description":"Hailuo 768P/1080P; H3 768P/2K; H3-Max 480P/768P; Wan 3.0 480P/720P/1080P. Default 768P on MiniMax, 720P on Wan."},
            "ratio":{"type":"string","description":"H3 and Wan 3.0: 21:9,16:9,4:3,1:1,3:4,9:16 or adaptive for image/reference input."},
            "firstFrame":{"type":"string"},"lastFrame":{"type":"string"},
            "referenceImages":{"type":"array","items":{"type":"string"},"maxItems":9},
            "referenceVideos":{"type":"array","items":{"type":"string"},"maxItems":3},
            "referenceAudio":{"type":"array","items":{"type":"string"},"maxItems":3}
        },"additionalProperties":false}) }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let result = self.run(input, ctx).await;
        Ok(match result {
            Ok(value) => value.to_string(),
            Err(error) => json!({"success":false,"error":error}).to_string(),
        })
    }
}
impl VideoTool {
    async fn run(&self, input: Value, ctx: &ToolContext) -> Result<Value, String> {
        let turn = config::turn_config(&ctx.thread_id)
            .ok_or("Video generation is available only in an Aurora Chat turn")?;
        jobs::folder(&turn.store, &ctx.thread_id)?;
        match input
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("generate")
        {
            "list" => {
                let catalog = catalog::catalog();
                Ok(json!({
                    "providers": turn.providers.iter().filter_map(|p| Vendor::of(p.api_format).map(|v| json!({"id":p.id,"name":p.name,"service":v.label(),"ready":p.ready()}))).collect::<Vec<_>>(),
                    "models": catalog.models,
                    "defaultModel": catalog.default_model,
                }))
            }
            "generate" => {
                let provider = provider(
                    &turn.providers,
                    input.get("provider").and_then(Value::as_str),
                    input.get("model").and_then(Value::as_str),
                )?;
                let request = serde_json::from_value(input)
                    .map_err(|e| format!("Invalid video arguments: {e}"))?;
                Ok(jobs::result(
                    &jobs::create(&turn.store, &ctx.thread_id, provider, request).await?,
                ))
            }
            "query" => {
                let id = input
                    .get("jobId")
                    .and_then(Value::as_str)
                    .ok_or("op=query requires jobId")?;
                let job = jobs::load(&jobs::folder(&turn.store, &ctx.thread_id)?, id).await?;
                let provider = provider(&turn.providers, Some(&job.provider_id), Some(&job.model))?;
                Ok(jobs::result(
                    &jobs::refresh(&turn.store, &ctx.thread_id, provider, id).await?,
                ))
            }
            _ => Err("Unknown video operation; use list, generate or query".into()),
        }
    }
}
