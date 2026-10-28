//! What a conversation shows beside its messages: artifacts on the canvas,
//! the task checklist, and the chat title. The artifact bodies are here (the
//! window's `commands/artifacts.rs` wraps them); the checklist and titles are
//! [`crate::tools::shell_editor_todo::todo_commands`] and
//! [`crate::agent_runtime::title_maker`], which the window registers directly.

use std::sync::Arc;

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::agent_runtime::artifacts::{
    load_bundle_unlocked, lock_artifacts, preview_patch, select, upsert, ArtifactSelectRequest,
    ArtifactUpsertRequest, ThreadArtifactBundle,
};
use crate::agent_runtime::host::AgentRegistry;
use crate::agent_runtime::title_maker;
use crate::api::client::ProviderConfigSnapshot;
use crate::tools::shell_editor_todo::todo_commands;

pub const COMMANDS: &[&str] = &[
    "thread_artifact_list",
    "thread_artifact_upsert",
    "thread_artifact_preview_patch",
    "thread_artifact_select",
    "todo_list_for_thread",
    "generate_thread_title",
    "generate_thread_title_cloud",
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
    let registry = ctx.registry.clone();
    Some(match name {
        "thread_artifact_list" => done(artifact_list(registry, get!("threadId")).await),
        "thread_artifact_upsert" => done(artifact_upsert(registry, get!("request")).await),
        "thread_artifact_preview_patch" => {
            done(artifact_preview_patch(registry, get!("request")).await)
        }
        "thread_artifact_select" => done(artifact_select(registry, get!("request")).await),
        "todo_list_for_thread" => done(todo_commands::todo_list_for_thread(get!("threadId")).await),
        "generate_thread_title" => {
            let base_url: String = get!("baseUrl");
            let api_key: Option<String> = get!("apiKey");
            let model: Option<String> = get!("model");
            let user_message: String = get!("userMessage");
            done(title_maker::generate_thread_title(base_url, api_key, model, user_message).await)
        }
        "generate_thread_title_cloud" => {
            let config: ProviderConfigSnapshot = get!("config");
            let model: String = get!("model");
            let user_message: String = get!("userMessage");
            let thread_id: Option<String> = get!("threadId");
            done(
                title_maker::generate_thread_title_cloud(config, model, user_message, thread_id)
                    .await,
            )
        }
        _ => return None,
    })
}

// Every artifact command routes by the conversation's OWN store. An Aurora
// Chat conversation lives under `Chats/`, and reading its bundle from the
// Build store finds nothing — worse, `upsert` refuses with "conversation not
// saved" for a chat that is saved, just elsewhere.

pub async fn artifact_list(
    registry: Arc<AgentRegistry>,
    thread_id: String,
) -> Result<ThreadArtifactBundle, String> {
    tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(ThreadArtifactBundle::empty(&thread_id));
        };
        let _guard = lock_artifacts()?;
        load_bundle_unlocked(&store, &thread_id)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

pub async fn artifact_upsert(
    registry: Arc<AgentRegistry>,
    request: ArtifactUpsertRequest,
) -> Result<ThreadArtifactBundle, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        upsert(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

pub async fn artifact_preview_patch(
    registry: Arc<AgentRegistry>,
    request: ArtifactUpsertRequest,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        preview_patch(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}

pub async fn artifact_select(
    registry: Arc<AgentRegistry>,
    request: ArtifactSelectRequest,
) -> Result<ThreadArtifactBundle, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&request.thread_id)
            .map_err(|e| e.to_string())?;
        select(&store, request)
    })
    .await
    .map_err(|e| format!("Artifact operation failed: {e}"))?
}
