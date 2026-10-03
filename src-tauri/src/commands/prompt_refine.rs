//! Tauri IPC for the composer's prompt-refine feature.
//!
//! Thin wrappers over [`crate::prompt_refine`]. `run` does the ~1s model call on
//! a blocking thread and returns the refined text; `cancel` kills an in-flight
//! child by request id; `validate` powers the Preferences "Validate" button.

use std::sync::Arc;

use tauri::State;

use crate::prompt_refine::{self, RefineConfig, RefineState, RefineValidation};

/// Check that the llama.cpp binary + model are present and usable.
#[tauri::command]
pub fn prompt_refine_validate(config: RefineConfig) -> RefineValidation {
    prompt_refine::validate(&config)
}

/// Refine `text` once and return the rewritten prompt. `request_id` lets the
/// frontend cancel this run. Never blocks the async runtime — the child process
/// I/O runs on a blocking thread.
#[tauri::command]
pub async fn prompt_refine_run(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_refine::refine(&st, &request_id, &text, &config)
    })
    .await
    .map_err(|e| format!("refine task failed: {e}"))?
}

/// Cancel an in-flight refine (kills the llama-completion child).
#[tauri::command]
pub fn prompt_refine_cancel(state: State<'_, Arc<RefineState>>, request_id: String) -> bool {
    state.cancel(&request_id)
}

/// Generate a chat title from the first user message using the SAME local
/// llama.cpp setup as prompt refine. Errors leave the caller on the derived
/// title, so this is always safe to attempt.
#[tauri::command]
pub async fn prompt_refine_title(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_refine::generate_title_local(&st, &request_id, &text, &config)
    })
    .await
    .map_err(|e| format!("title task failed: {e}"))?
}

/// Rewrite a voice-dictation transcript into clean written text. Errors leave
/// the caller inserting the raw transcript, so this is always safe to attempt.
#[tauri::command]
pub async fn prompt_refine_dictation(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    text: String,
    config: RefineConfig,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_refine::clean_dictation(&st, &request_id, &text, &config)
    })
    .await
    .map_err(|e| format!("dictation task failed: {e}"))?
}

/// Generate up to 4 tappable reply suggestions from the last exchange — the
/// model sees the user's message AND the assistant's reply and answers as
/// the user (fewer chips when outputs fail the quality filters).
#[tauri::command]
pub async fn prompt_refine_suggest(
    state: State<'_, Arc<RefineState>>,
    request_id: String,
    user_text: String,
    text: String,
    config: RefineConfig,
) -> Result<Vec<String>, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_refine::suggest_replies(&st, &request_id, &user_text, &text, &config)
    })
    .await
    .map_err(|e| format!("suggest task failed: {e}"))?
}

/// How long a cloud suggestion call may take before it is dropped. The chips
/// are only useful while the user is still deciding what to type.
const CLOUD_SUGGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Room for four short numbered lines, with slack for a model that adds a
/// sentence before the list.
const CLOUD_SUGGEST_MAX_TOKENS: u32 = 300;

/// Reply suggestions from one of the user's configured models instead of the
/// local llama.cpp one.
///
/// Same instruction, same input, and same filtering as the local path
/// ([`prompt_refine::suggestion_exchange`] / [`prompt_refine::parse_suggestions`]),
/// so switching model changes who writes the chips, not what they look like.
/// Goes through [`crate::api::build_api_client`], the factory a real turn uses,
/// so every provider kind works here, including the OAuth ones. Reasoning is
/// off: four short replies do not need it, and it is the expensive part.
#[tauri::command]
pub async fn reply_suggest_cloud(
    config: crate::api::client::ProviderConfigSnapshot,
    model: String,
    user_text: String,
    text: String,
) -> Result<Vec<String>, String> {
    use crate::agent_runtime::api_client::{ApiRequest, ReasoningRequest};
    use crate::agent_runtime::events::AssistantEvent;
    use crate::agent_runtime::types::{ContentBlock, ConversationMessage};

    if model.trim().is_empty() {
        return Err("no model selected for reply suggestions".to_string());
    }
    let exchange = prompt_refine::suggestion_exchange(&user_text, &text)?;

    let client = crate::api::build_api_client(&config);
    let messages = vec![ConversationMessage::user_text(&exchange, 0)];
    let request = ApiRequest {
        model: &model,
        system_prompt: Some(prompt_refine::suggestion_system_prompt()),
        messages: &messages,
        tools: &[],
        tool_choice: Default::default(),
        temperature: Some(0.7),
        max_output_tokens: CLOUD_SUGGEST_MAX_TOKENS,
        reasoning: ReasoningRequest::disabled(),
        tool_bridge: None,
        // Belongs to no conversation, so no cache-affinity key.
        session_key: None,
    };

    // Drain the sink concurrently: the adapters `.send().await` into it, so a
    // full buffer would deadlock the stream against itself.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AssistantEvent>(64);
    let collector = tokio::spawn(async move {
        let mut streamed = String::new();
        while let Some(event) = rx.recv().await {
            if let AssistantEvent::TextDelta { delta } = event {
                streamed.push_str(&delta);
            }
        }
        streamed
    });

    let outcome = tokio::time::timeout(
        CLOUD_SUGGEST_TIMEOUT,
        client.stream(request, tx, tokio_util::sync::CancellationToken::new()),
    )
    .await;
    let streamed = collector.await.unwrap_or_default();

    let usage = match outcome {
        Err(_) => {
            return Err(format!(
                "no reply within {}s",
                CLOUD_SUGGEST_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(err)) => return Err(err.to_string()),
        Ok(Ok(usage)) => usage,
    };

    // Prefer the assembled message; fall back to the raw deltas for a provider
    // that only streams and returns an empty final message.
    let assembled: String = usage
        .assistant_message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let raw = if assembled.trim().is_empty() {
        streamed
    } else {
        assembled
    };
    Ok(prompt_refine::parse_suggestions(&raw))
}
