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
//!
//! **A picture in the message makes it an edit.** The composer and the Images
//! page both send an attached picture the way every chat does, as an
//! `<aurora_image>` marker in the message text. Before this, the marker went to
//! the image model as part of the PROMPT — base64 and all — and no edit was
//! ever possible from either place, even with a model whose provider can edit.
//! Now the marker is split off: the picture is stored as the conversation's
//! attached asset (the same `ingest` step a chat turn runs), the text alone is
//! the instruction, and the call goes to the provider's edit endpoint. One
//! picture per edit; a model that cannot edit is refused before anything is
//! written or billed.

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent_runtime::ipc::AgentExecutionMode;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use crate::api::aurora_image;
use crate::commands::agent_v2::AgentRegistry;
use crate::tools::image::assets::{self, AssetRecord, AssetSource, NewAsset};
use crate::tools::image::client::ImageClient;
use crate::tools::image::config::{resolve_model, ImageModelConfig, ImageProviderConfig};
use crate::tools::image::ingest;
use crate::tools::image::wire::{EditSource, GenerationCall, WireError};

/// Longest prompt forwarded, mirroring the tool's own cap.
const MAX_PROMPT_CHARS: usize = 4_000;
/// Longest Canvas title, mirroring `commands::artifacts::MAX_TITLE_LEN`.
const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDirectRequest {
    pub thread_id: String,
    /// What the user typed, persisted as their message. Its text is the
    /// prompt; an `<aurora_image>` marker in it is the picture to edit.
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
    let (text, attached) = prompt_text(&request.prompt);
    let prompt = text.as_str();
    if attached > 1 {
        return Err(format!(
            "Edit one picture at a time — this message has {attached}. Keep the one to change."
        ));
    }
    if prompt.is_empty() {
        return Err(if attached == 1 {
            "Say what to change — the text beside the picture is the edit instruction.".into()
        } else {
            "Describe the picture first — the message is the prompt.".into()
        });
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
    let resolved = resolve_model(&providers, None, Some(&request.model)).map_err(|e| e.to_string())?;
    // Refused before the thread is touched: nothing is written and nothing is
    // billed for an edit this model was never going to make.
    if let Some(reason) = edit_refusal(&resolved.provider, &resolved.model, attached) {
        return Err(reason);
    }
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
    let session_path = store.session_path(thread_id);

    // The attached picture, stored as this conversation's asset — the same
    // `ingest` a chat turn runs, so it is listed, placed in the Canvas and
    // usable as a later edit's source like any pasted picture. The message
    // keeps the marker (now naming the file) so the bubble shows the picture.
    let (user_text, source) = if attached == 1 {
        let ingested = ingest::ingest_user_images_into(&assets_dir, &request.prompt, Some((&store, thread_id)));
        let source = match ingested.stored.into_iter().next() {
            Some(record) => record,
            // A marker that names an existing asset carries no bytes to store.
            None => existing_source(&assets_dir, &request.prompt)?,
        };
        (ingested.text, Some(source))
    } else {
        (prompt.to_string(), None)
    };

    // The user's message lands first and is journaled at once, so a provider
    // that takes forty seconds and then fails still leaves the question asked.
    {
        let mut session = session_arc.lock().await;
        session.model = Some(request.model_selection.clone());
        session.append_message(ConversationMessage::user_text(
            user_text,
            Utc::now().timestamp_millis(),
        ));
    }

    let started = std::time::Instant::now();
    let client = ImageClient::new();
    let call = GenerationCall {
        model: &resolved.model.model_key,
        prompt,
        size: size.as_deref(),
        format: resolved.provider.request_format,
    };
    let response = match &source {
        Some(record) => {
            let bytes = std::fs::read(assets::path_of(&assets_dir, record)).map_err(|e| {
                format!("the attached picture was saved but could not be read back ({e})")
            })?;
            client
                .edit(
                    &resolved.provider,
                    call,
                    EditSource {
                        bytes: &bytes,
                        media_type: &record.media_type,
                        file_name: &record.name,
                        remote_url: record.remote_url.as_deref(),
                    },
                )
                .await
        }
        None => client.generate(&resolved.provider, call).await,
    }
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
            source: if source.is_some() { AssetSource::Edited } else { AssetSource::Generated },
            hint: prompt.to_string(),
            declared_media_type: None,
            prompt: Some(prompt.to_string()),
            model: Some(resolved.model.model_key.clone()),
            provider: Some(resolved.provider.name.clone()),
            remote_url: output.url.clone(),
            // An edit remembers what it was made from, as the tool's edits do.
            parent: source.as_ref().map(|record| record.name.clone()),
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

/// The message with its picture markers taken out, and how many there were.
///
/// The text is what the image model is asked for; a marker is a picture, and
/// sending one as prompt text was how base64 used to reach the model as words.
fn prompt_text(message: &str) -> (String, usize) {
    let mut text = String::with_capacity(message.len());
    let mut cursor = 0usize;
    let mut count = 0usize;
    while let Some(marker) = aurora_image::find_marker(message, cursor) {
        text.push_str(&message[cursor..marker.start]);
        cursor = marker.end;
        count += 1;
    }
    text.push_str(&message[cursor..]);
    // Collapse the blank lines left where markers sat.
    let mut collapsed = String::with_capacity(text.len());
    let mut blank_run = 0usize;
    for line in text.trim().lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !collapsed.is_empty() {
            collapsed.push('\n');
        }
        collapsed.push_str(line);
    }
    (collapsed.trim().to_string(), count)
}

/// Why this model cannot take the attached picture, or `None` when it can (or
/// there is nothing attached).
fn edit_refusal(
    provider: &ImageProviderConfig,
    model: &ImageModelConfig,
    attached: usize,
) -> Option<String> {
    if attached == 0 || provider.can_edit_with(model) {
        return None;
    }
    Some(if provider.edit_url().is_none() {
        format!(
            "{} cannot edit pictures — {} has no edit endpoint. Remove the picture to make a new \
one, or pick a model marked as able to edit.",
            model.model_key, provider.name
        )
    } else {
        format!(
            "{} is not marked as able to edit pictures. Remove the picture to make a new one, or \
pick a model marked as able to edit (Settings → Providers → Image providers).",
            model.model_key
        )
    })
}

/// The asset a lean marker (`src`, no bytes) names, for a picture that is
/// already in this conversation.
fn existing_source(assets_dir: &std::path::Path, message: &str) -> Result<AssetRecord, String> {
    let name = aurora_image::find_marker(message, 0)
        .and_then(|marker| marker.src())
        .ok_or_else(|| "The attached picture could not be read. Attach it again.".to_string())?;
    assets::list(assets_dir)?
        .into_iter()
        .find(|record| record.name == name)
        .ok_or_else(|| format!("The picture '{name}' is no longer in this conversation. Attach it again."))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOT: &str = "<aurora_image media_type=\"image/png\">iVBORw0KGgo=</aurora_image>";

    #[test]
    fn a_plain_prompt_has_no_picture() {
        assert_eq!(prompt_text("a red fox at dawn"), ("a red fox at dawn".to_string(), 0));
    }

    #[test]
    fn the_marker_is_the_picture_and_the_text_is_the_instruction() {
        let (text, count) = prompt_text(&format!("make the sky purple\n\n{DOT}"));
        assert_eq!(count, 1);
        assert_eq!(text, "make the sky purple");
        assert!(!text.contains("aurora_image"));
    }

    #[test]
    fn every_marker_is_counted() {
        assert_eq!(prompt_text(&format!("blend these\n{DOT}\n{DOT}")).1, 2);
    }

    #[test]
    fn prose_that_quotes_the_syntax_is_not_a_picture() {
        let quoted = "explain <aurora_image ...> markers";
        assert_eq!(prompt_text(quoted), (quoted.to_string(), 0));
    }

    fn provider(edit_path: Option<&str>, can_edit: bool) -> ImageProviderConfig {
        use crate::tools::image::config::ImageApiFormat;
        ImageProviderConfig {
            id: "p".into(),
            name: "Studio".into(),
            base_url: "https://api.example.com/v1/".into(),
            api_key: Some("sk-test".into()),
            api_format: ImageApiFormat::OpenaiImages,
            generation_path: None,
            edit_path: edit_path.map(str::to_string),
            request_format: None,
            enabled: true,
            models: vec![ImageModelConfig {
                id: "p:m".into(),
                provider_id: "p".into(),
                model_key: "gpt-image-1.5".into(),
                label: None,
                can_edit,
                sizes: vec![],
                default_size: None,
                price_per_image: None,
            }],
        }
    }

    #[test]
    fn nothing_attached_is_never_refused() {
        let p = provider(Some(""), false);
        assert_eq!(edit_refusal(&p, &p.models[0], 0), None);
    }

    #[test]
    fn an_edit_capable_model_takes_the_picture() {
        let p = provider(None, true);
        assert_eq!(edit_refusal(&p, &p.models[0], 1), None);
    }

    #[test]
    fn a_model_not_marked_to_edit_is_refused_with_where_to_mark_it() {
        let p = provider(None, false);
        let reason = edit_refusal(&p, &p.models[0], 1).expect("refused");
        assert!(reason.contains("not marked as able to edit"));
        assert!(reason.contains("Image providers"));
    }

    #[test]
    fn a_provider_without_an_edit_endpoint_is_refused_by_name() {
        let p = provider(Some(""), true);
        let reason = edit_refusal(&p, &p.models[0], 1).expect("refused");
        assert!(reason.contains("Studio has no edit endpoint"));
    }
}
