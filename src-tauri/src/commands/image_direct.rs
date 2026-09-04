//! Path A of Aurora Chat's picture making: **the conversation's model IS an
//! image model.** You type a prompt, send, get a picture. No language model
//! in between, no tool call, no slash command.
//!
//! One command does the whole turn, because the turn is one call: append the
//! user's message, ask the image provider, land the bytes in the
//! conversation's `assets/` and the Canvas, append an assistant message whose
//! only block is the picture, persist, title. The frontend shows the silk
//! placeholder at the requested aspect while this awaits and crossfades the
//! picture in when it returns.
//!
//! **Only the current message is sent.** An image model has no history to
//! read; the composer says so. Titles come from the prompt (a language model
//! is not asked to name a picture), and compaction never runs here because no
//! transcript is ever assembled for a provider — the two "fall back" cases the
//! design record lists are satisfied by there being nothing to fall back from.

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent_runtime::ipc::AgentExecutionMode;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use crate::commands::agent_v2::AgentRegistry;
use crate::tools::image::assets::{self, AssetSource, NewAsset};
use crate::tools::image::client::ImageClient;
use crate::tools::image::config::{resolve_model, ImageProviderConfig};
use crate::tools::image::wire::{GenerationCall, WireError};

/// Longest prompt forwarded, mirroring the tool's own cap.
const MAX_PROMPT_CHARS: usize = 4_000;
/// Longest Canvas title, mirroring `commands::artifacts::MAX_TITLE_LEN`.
const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDirectRequest {
    pub thread_id: String,
    /// What the user typed. Persisted as their message and sent as the prompt.
    pub prompt: String,
    /// The provider the conversation's model belongs to — the settings row,
    /// sent as stored, the same way chat turns hand rows to `generate_image`.
    pub provider: ImageProviderConfig,
    /// The model key inside that provider.
    pub model: String,
    /// `WIDTHxHEIGHT`, when the user chose one; the model's default otherwise.
    #[serde(default)]
    pub size: Option<String>,
    /// The conversation's pin, `"<providerId>:<modelKey>"`, written to the
    /// sidecar so the composer shows this model when the chat is reopened.
    pub model_selection: String,
}

/// What came back: the picture as the transcript renders it. The same fields
/// the reload path emits for a persisted [`ContentBlock::Image`], so the live
/// card and the reopened card are built from one shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDirectResult {
    pub asset: String,
    pub path: String,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub prompt: String,
    pub model: String,
    pub artifact_id: String,
    /// Some models rewrite the prompt and say so.
    pub revised_prompt: Option<String>,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn image_direct_generate(
    state: State<'_, Arc<AgentRegistry>>,
    request: ImageDirectRequest,
) -> Result<ImageDirectResult, String> {
    generate(&state, request).await
}

async fn generate(
    registry: &AgentRegistry,
    request: ImageDirectRequest,
) -> Result<ImageDirectResult, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("Describe the picture first — the message is the prompt.".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "That prompt is {} characters; image models take up to {MAX_PROMPT_CHARS}. Shorten it.",
            prompt.chars().count()
        ));
    }
    let thread_id = request.thread_id.trim();
    if thread_id.is_empty() {
        return Err("No conversation to put the picture in.".into());
    }

    // The provider row is what the frontend has; `resolve_model` applies the
    // same readiness rules the tool does, so a row missing its key fails here
    // with the same words it would fail with in a chat turn.
    let providers = vec![request.provider.clone()];
    let resolved = resolve_model(&providers, Some(&request.model)).map_err(|e| e.to_string())?;
    let size = match request.size.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(size) if resolved.model.sizes.is_empty() || resolved.model.sizes.iter().any(|s| s == size) => {
            Some(size.to_string())
        }
        Some(size) => {
            return Err(format!(
                "{size} is not a size {} offers. It offers: {}.",
                resolved.model.model_key,
                resolved.model.sizes.join(", ")
            ))
        }
        None => resolved.model.default_size.clone(),
    };

    let store = registry.chat_store().clone();
    let assets_dir = store
        .assets_dir(thread_id)
        .ok_or_else(|| "This conversation's store has no place for pictures.".to_string())?;

    // The thread exists on disk before anything slow runs, so a chat the user
    // navigates away from while the picture is being made is still listed.
    store
        .ensure_thread(thread_id, None, None)
        .map_err(|e| e.to_string())?;
    let session_arc = registry
        .load_or_create_session_in(AgentExecutionMode::Chat, thread_id)
        .map_err(|e| e.to_string())?;
    let session_path = registry.session_path_in(AgentExecutionMode::Chat, thread_id);

    // The user's message lands first and is journaled at once, so a provider
    // that takes forty seconds and then fails still leaves the question asked.
    {
        let mut session = session_arc.lock().await;
        session.model = Some(request.model_selection.clone());
        session.append_message(ConversationMessage::user_text(
            prompt,
            Utc::now().timestamp_millis(),
        ));
    }

    let started = std::time::Instant::now();
    let client = ImageClient::new();
    let response = client
        .generate(
            &resolved.provider,
            GenerationCall {
                model: &resolved.model.model_key,
                prompt,
                size: size.as_deref(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let output = response
        .images
        .into_iter()
        .next()
        .ok_or_else(|| WireError::NoImage.to_string())?;
    let bytes = client
        .materialize(&output, assets::MAX_ASSET_BYTES)
        .await
        .map_err(|e| e.to_string())?;

    let record = assets::store(
        &assets_dir,
        NewAsset {
            source: AssetSource::Generated,
            hint: prompt.to_string(),
            declared_media_type: None,
            prompt: Some(prompt.to_string()),
            model: Some(resolved.model.model_key.clone()),
            provider: Some(resolved.provider.name.clone()),
            remote_url: output.url.clone(),
            parent: None,
        },
        &bytes,
    )?;
    let artifact_id = crate::tools::image::place_in_canvas(
        &store,
        thread_id,
        &assets_dir,
        &record,
        &title_of(prompt),
    )?;
    let path = assets::display_path(&assets::path_of(&assets_dir, &record));

    {
        let mut session = session_arc.lock().await;
        session.append_message(ConversationMessage::assistant(
            vec![ContentBlock::Image {
                asset: record.name.clone(),
                path: path.clone(),
                media_type: record.media_type.clone(),
                width: record.width,
                height: record.height,
                prompt: Some(prompt.to_string()),
                model: Some(resolved.model.model_key.clone()),
                artifact: Some(artifact_id.clone()),
            }],
            Utc::now().timestamp_millis(),
        ));
        session
            .save_to_path(&session_path)
            .map_err(|e| format!("the picture was made but the conversation was not saved: {e}"))?;
    }

    // Sidecar: model pin, a title from the prompt while the chat is still
    // "New Chat", and the timestamp bump that floats it to the top of the rail.
    let _ = store.set_workspace_and_model(thread_id, None, Some(request.model_selection.clone()));
    let needs_title = store
        .load_metadata(thread_id)
        .map(|m| m.title == "New Chat")
        .unwrap_or(false);
    if needs_title {
        let derived = crate::agent_runtime::title::derive_thread_title(prompt);
        if !derived.is_empty() && derived != "New Chat" {
            let _ = store.set_title(thread_id, derived);
        }
    }
    let _ = store.touch(thread_id);
    if let Some(memory) = crate::chat_memory::service() {
        if let Err(err) = memory.index_chat(&store, thread_id) {
            crate::logging::log_warn(
                "chat_memory",
                &format!("could not index chat {thread_id}: {err}"),
            );
        }
    }

    Ok(ImageDirectResult {
        asset: record.name,
        path,
        media_type: record.media_type,
        width: record.width,
        height: record.height,
        prompt: prompt.to_string(),
        model: resolved.model.model_key,
        artifact_id,
        revised_prompt: output.revised_prompt,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// The Canvas title: the prompt, one line, capped.
fn title_of(prompt: &str) -> String {
    let mut title: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() > MAX_TITLE_CHARS {
        title = title.chars().take(MAX_TITLE_CHARS - 1).collect();
        title.push('…');
    }
    title
}
