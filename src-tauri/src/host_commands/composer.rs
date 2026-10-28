//! What helps the person write: the ✦ prompt rewrite, local titles and
//! dictation clean-up, reply suggestions and what was done with them, and
//! the local model servers (LM Studio, Ollama) the composer can pick. Bodies
//! in [`crate::prompt_refine::commands`] and
//! [`crate::api::local_providers::commands`]; the window calls the same ones.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::api::client::ProviderConfigSnapshot;
use crate::api::local_providers::commands as local;
use crate::prompt_refine::commands as refine;
use crate::prompt_refine::RefineConfig;
use crate::reply_suggest::log::OutcomeInput;

pub const COMMANDS: &[&str] = &[
    "prompt_refine_validate",
    "prompt_refine_run",
    "prompt_refine_cloud",
    "prompt_refine_cancel",
    "prompt_refine_title",
    "prompt_refine_dictation",
    "prompt_refine_suggest",
    "reply_suggest_cloud",
    "reply_suggest_outcome",
    "local_provider_detect",
    "local_provider_probe_custom",
    "local_provider_show_ollama_model",
    "local_provider_get_running_models",
    "local_provider_load_ollama_model",
    "local_provider_unload_ollama_model",
    "local_provider_delete_ollama_model",
    "local_provider_pull_ollama_model",
    "cancel_local_provider_pull",
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
    let st = ctx.refine.clone();
    let registry = ctx.registry.clone();
    Some(match name {
        "prompt_refine_validate" => {
            let config: RefineConfig = get!("config");
            done(Ok(refine::prompt_refine_validate(config)))
        }
        "prompt_refine_run" => {
            let request_id: String = get!("requestId");
            let text: String = get!("text");
            let config: RefineConfig = get!("config");
            done(refine::prompt_refine_run(st, request_id, text, config).await)
        }
        "prompt_refine_cloud" => {
            let request_id: String = get!("requestId");
            let text: String = get!("text");
            let config: ProviderConfigSnapshot = get!("config");
            let model: String = get!("model");
            done(refine::prompt_refine_cloud(st, request_id, text, config, model).await)
        }
        "prompt_refine_cancel" => {
            let request_id: String = get!("requestId");
            done(Ok(refine::prompt_refine_cancel(&st, request_id)))
        }
        "prompt_refine_title" => {
            let request_id: String = get!("requestId");
            let text: String = get!("text");
            let config: RefineConfig = get!("config");
            done(refine::prompt_refine_title(st, request_id, text, config).await)
        }
        "prompt_refine_dictation" => {
            let request_id: String = get!("requestId");
            let text: String = get!("text");
            let config: RefineConfig = get!("config");
            done(refine::prompt_refine_dictation(st, request_id, text, config).await)
        }
        "prompt_refine_suggest" => {
            let request_id: String = get!("requestId");
            let user_text: String = get!("userText");
            let text: String = get!("text");
            let config: RefineConfig = get!("config");
            let thread_id: Option<String> = get!("threadId");
            let run_id: Option<String> = get!("runId");
            done(
                refine::prompt_refine_suggest(
                    st, registry, request_id, user_text, text, config, thread_id, run_id,
                )
                .await,
            )
        }
        "reply_suggest_cloud" => {
            let config: ProviderConfigSnapshot = get!("config");
            let model: String = get!("model");
            let thread_id: String = get!("threadId");
            let run_id: String = get!("runId");
            done(refine::reply_suggest_cloud(registry, config, model, thread_id, run_id).await)
        }
        "reply_suggest_outcome" => {
            let thread_id: String = get!("threadId");
            let outcome: OutcomeInput = get!("outcome");
            done(refine::reply_suggest_outcome(registry, thread_id, outcome).await)
        }

        "local_provider_detect" => done(local::local_provider_detect(get!("customUrl")).await),
        "local_provider_probe_custom" => done(local::local_provider_probe_custom(get!("url")).await),
        "local_provider_show_ollama_model" => {
            let base_url: String = get!("baseUrl");
            let model_name: String = get!("modelName");
            done(local::local_provider_show_ollama_model(base_url, model_name).await)
        }
        "local_provider_get_running_models" => {
            done(local::local_provider_get_running_models(get!("baseUrl")).await)
        }
        "local_provider_load_ollama_model" => {
            let base_url: String = get!("baseUrl");
            let model_name: String = get!("modelName");
            let keep_alive: Option<String> = get!("keepAlive");
            done(local::local_provider_load_ollama_model(base_url, model_name, keep_alive).await)
        }
        "local_provider_unload_ollama_model" => {
            let base_url: String = get!("baseUrl");
            let model_name: String = get!("modelName");
            done(local::local_provider_unload_ollama_model(base_url, model_name).await)
        }
        "local_provider_delete_ollama_model" => {
            let base_url: String = get!("baseUrl");
            let model_name: String = get!("modelName");
            done(local::local_provider_delete_ollama_model(base_url, model_name).await)
        }
        "local_provider_pull_ollama_model" => {
            let request_id: String = get!("requestId");
            let base_url: String = get!("baseUrl");
            let model_name: String = get!("modelName");
            done(local::pull_ollama_model(ctx.events.clone(), request_id, base_url, model_name).await)
        }
        "cancel_local_provider_pull" => {
            done(local::cancel_local_provider_pull(get!("requestId")))
        }
        _ => return None,
    })
}
