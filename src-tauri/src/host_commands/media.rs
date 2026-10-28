//! Pictures and video: the Images page's direct generation, an image
//! provider's Test and Discover buttons, the video model list, and checking a
//! video job. Bodies in [`crate::tools::image`] and [`crate::tools::video`];
//! the window's commands call the same functions.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::agent_runtime::host::AgentRegistry;
use crate::tools::image::config::ImageProviderConfig;
use crate::tools::image::direct::{self, ImageDirectRequest};
use crate::tools::image::provider_commands;
use crate::tools::video;

pub const COMMANDS: &[&str] = &[
    "image_direct_generate",
    "image_provider_test",
    "image_provider_discover_models",
    "video_model_catalog",
    "chat_video_refresh",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "image_direct_generate" => {
            let request: ImageDirectRequest = get!("request");
            done(direct::generate(&ctx.registry, request).await)
        }
        "image_provider_test" => {
            let config: ImageProviderConfig = get!("config");
            done(Ok(provider_commands::image_provider_test(config).await))
        }
        "image_provider_discover_models" => {
            let config: ImageProviderConfig = get!("config");
            done(provider_commands::image_provider_discover_models(config).await)
        }
        "video_model_catalog" => done(Ok(video::catalog::catalog())),
        "chat_video_refresh" => {
            let thread_id: String = get!("threadId");
            let job_id: String = get!("jobId");
            let provider: ImageProviderConfig = get!("provider");
            done(video_refresh(&ctx.registry, &thread_id, &job_id, provider).await)
        }
        _ => return None,
    })
}

/// Check one video job and return what the chat shows for it. Never creates a
/// task.
pub async fn video_refresh(
    registry: &AgentRegistry,
    thread_id: &str,
    job_id: &str,
    provider: ImageProviderConfig,
) -> Result<Value, String> {
    let providers = [provider];
    // The row the caller handed over is the only candidate, and the job's own
    // record decides the service, so neither needs narrowing here.
    let provider = video::provider(&providers, None, None)?;
    let job = video::jobs::refresh(registry.chat_store(), thread_id, provider, job_id).await?;
    Ok(video::jobs::result(&job))
}
