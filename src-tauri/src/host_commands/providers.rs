//! Provider setup that is not a sign-in: the built-in presets, asking a
//! provider for its model list, and "does this model answer?". Also the IDE
//! chat's plain request and stream (`aurora_provider_*`), whose chunks arrive
//! as `aurora-provider-stream-*` events through the host's sink. The bodies are
//! in [`crate::api`], which the window registers directly. The saved provider
//! rows and their models are `host_commands::settings`.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel::commands as kernel;
use crate::api::provider_kernel::AuroraProviderRequest;
use crate::api::{provider_catalog, provider_models, provider_test};

pub const COMMANDS: &[&str] = &[
    "provider_catalog_get_presets",
    "provider_list_models",
    "provider_test_model",
    "aurora_provider_chat",
    "aurora_provider_stream",
    "cancel_aurora_provider_stream",
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
        "provider_catalog_get_presets" => {
            done(provider_catalog::commands::provider_catalog_get_presets().await)
        }
        "provider_list_models" => {
            let base_url: String = get!("baseUrl");
            let api_key: String = get!("apiKey");
            let provider_type: Option<String> = get!("providerType");
            done(provider_models::provider_list_models(base_url, api_key, provider_type).await)
        }
        "provider_test_model" => {
            let config: ProviderConfigSnapshot = get!("config");
            let model: String = get!("model");
            done(provider_test::provider_test_model(config, model).await)
        }
        "aurora_provider_chat" => {
            let request: AuroraProviderRequest = get!("request");
            done(kernel::aurora_provider_chat(request).await)
        }
        "aurora_provider_stream" => {
            let request_id: String = get!("requestId");
            let request: AuroraProviderRequest = get!("request");
            done(kernel::provider_stream(ctx.events.clone(), request_id, request).await)
        }
        "cancel_aurora_provider_stream" => {
            done(kernel::cancel_aurora_provider_stream(get!("requestId")))
        }
        _ => return None,
    })
}
