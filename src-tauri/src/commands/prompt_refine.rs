//! Tauri IPC for the composer's prompt-refine feature.
//!
//! Thin wrappers over [`crate::prompt_refine`]. `run` does the ~1s model call on
//! a blocking thread and returns the refined text; `cancel` kills an in-flight
//! child by request id; `validate` powers the Preferences "Validate" button.

use std::sync::Arc;

use tauri::State;

use super::agent_v2::AgentRegistry;
use crate::prompt_refine::{self, RefineConfig, RefineState, RefineValidation};
use crate::reply_suggest::{self, log as suggest_log};

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

/// The conversation folder and its project folder, for the suggestion log.
/// `None` for a conversation that is not on disk (nothing to log beside).
fn suggestion_dirs(
    registry: &AgentRegistry,
    thread_id: &str,
) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    match registry.store_for_thread(thread_id) {
        Ok(Some(store)) => Some((store.thread_dir(thread_id), store.dir().to_path_buf())),
        Ok(None) => None,
        Err(err) => {
            crate::logging::log_warn(
                "reply_suggest",
                &format!("could not locate conversation {thread_id} for the suggestion log: {err}"),
            );
            None
        }
    }
}

/// Write a run to the conversation's suggestion log. A failed write is logged
/// and never fails the suggestions themselves.
fn log_run(thread_dir: &std::path::Path, record: &suggest_log::RunRecord) {
    if let Err(err) = suggest_log::write_run(thread_dir, record) {
        crate::logging::log_warn("reply_suggest", &format!("suggestion log not written: {err}"));
    }
}

/// Generate up to 4 tappable reply suggestions from the last exchange on the
/// LOCAL model — the model sees the user's message AND the assistant's reply
/// and answers as the user (fewer chips when outputs fail the quality filters).
/// Kept light on purpose: one exchange in, no tools, no conversation brief.
///
/// With `thread_id` and `run_id`, the run is written to that conversation's
/// `suggestions.jsonl` like a cloud run.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn prompt_refine_suggest(
    state: State<'_, Arc<RefineState>>,
    registry: State<'_, Arc<AgentRegistry>>,
    request_id: String,
    user_text: String,
    text: String,
    config: RefineConfig,
    thread_id: Option<String>,
    run_id: Option<String>,
) -> Result<Vec<String>, String> {
    let st = state.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result = prompt_refine::suggest_replies_traced(&st, &request_id, &user_text, &text, &config);

        if let (Some(thread_id), Some(run_id)) = (thread_id.as_deref(), run_id.as_deref()) {
            if let Some((thread_dir, _)) = suggestion_dirs(&registry, thread_id) {
                let (input, raw, suggestions, error) = match &result {
                    Ok(run) => (run.input.clone(), run.raw.clone(), run.suggestions.clone(), None),
                    Err(err) => (String::new(), String::new(), Vec::new(), Some(err.clone())),
                };
                let model = std::path::Path::new(&config.model_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| config.model_path.clone());
                log_run(
                    &thread_dir,
                    &suggest_log::RunRecord {
                        kind: "run",
                        run_id: run_id.to_string(),
                        at: chrono::Utc::now().to_rfc3339(),
                        thread_id: thread_id.to_string(),
                        path: "local",
                        model,
                        prompt_version: "local-v1",
                        thinking_requested: false,
                        input_chars: input.chars().count(),
                        input,
                        brief: None,
                        thinking: String::new(),
                        raw_text: raw,
                        tool_input: None,
                        answered_via: if suggestions.is_empty() { "none" } else { "text" },
                        suggestions,
                        usage: None,
                        stop_reason: None,
                        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                        error,
                    },
                );
            }
        }
        result.map(|run| run.suggestions)
    })
    .await
    .map_err(|e| format!("suggest task failed: {e}"))?
}

/// Reply suggestions from one of the user's configured models, written from
/// the whole conversation (see [`crate::reply_suggest`]).
///
/// Reads the conversation from disk by `thread_id`, so the window sends only
/// which conversation and which model. Every run — answered, empty, timed out
/// or failed — is written to the conversation's `suggestions.jsonl` under
/// `run_id`, which the window echoes back when it reports what the developer
/// did with the chips.
#[tauri::command]
pub async fn reply_suggest_cloud(
    registry: State<'_, Arc<AgentRegistry>>,
    config: crate::api::client::ProviderConfigSnapshot,
    model: String,
    thread_id: String,
    run_id: String,
) -> Result<Vec<String>, String> {
    if model.trim().is_empty() {
        return Err("no model selected for reply suggestions".to_string());
    }
    let registry = registry.inner().clone();
    let lookup_id = thread_id.clone();
    let located = tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&lookup_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("conversation {lookup_id} is not on disk"))?;
        let loaded = store
            .load(&lookup_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("conversation {lookup_id} has no messages on disk"))?;
        // Aurora Chat's conversations live in their own store; anything else
        // is a project's.
        let chat = Arc::ptr_eq(&store, registry.chat_store());
        Ok::<_, String>((
            store.thread_dir(&lookup_id),
            store.dir().to_path_buf(),
            loaded.session.messages().to_vec(),
            chat,
        ))
    })
    .await
    .map_err(|e| format!("suggestion lookup failed: {e}"))??;
    let (thread_dir, project_dir, messages, chat) = located;

    let run = reply_suggest::run_cloud(
        &config,
        &model,
        reply_suggest::RunContext {
            run_id: &run_id,
            thread_id: &thread_id,
            thread_dir: &thread_dir,
            project_dir: &project_dir,
            messages: &messages,
            think: false,
            chat,
        },
    )
    .await;
    let error = run.record.error.clone();
    log_run(&thread_dir, &run.record);
    if run.suggestions.is_empty() {
        return Err(error.unwrap_or_else(|| "no suggestions".to_string()));
    }
    Ok(run.suggestions)
}

/// Record what the developer did with a set of chips: sent one unchanged,
/// changed one, typed their own, or sent before the chips arrived. Written to
/// the conversation's log and the project's outcome file; the cloud model
/// learns from the latter.
#[tauri::command]
pub async fn reply_suggest_outcome(
    registry: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    outcome: suggest_log::OutcomeInput,
) -> Result<(), String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (thread_dir, project_dir) = suggestion_dirs(&registry, &thread_id)
            .ok_or_else(|| format!("conversation {thread_id} is not on disk"))?;
        suggest_log::write_outcome(&thread_dir, &project_dir, &thread_id, outcome)
    })
    .await
    .map_err(|e| format!("outcome task failed: {e}"))?
}
