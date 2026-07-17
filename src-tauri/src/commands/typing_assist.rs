//! Tauri IPC surface for the composer's typing assistance.
//!
//! Thin wrappers over [`crate::typing_assist`]. The engine is lazily built on
//! first activation (`typing_assist_ensure_ready`); every other command is a
//! fast, local lookup so the frontend can call `query`/`correct` per keystroke
//! (debounced) without a perceptible round-trip.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::typing_assist::{Ghost, GhostKind, TypingAssistState};

/// One inline ghost suggestion for the composer to render.
#[derive(Serialize)]
pub struct GhostDto {
    /// Text to insert at the caret when accepted.
    pub insert: String,
    /// The full word (so the frontend can teach the lexicon on accept).
    pub word: String,
    /// `"completion"` (extends the typed word) or `"next_word"` (a fresh word).
    pub kind: String,
}

/// Build the engine if it isn't loaded yet (copies bundled dictionaries into
/// app-data on first run, then indexes them off-thread). Returns `true` once
/// the engine is ready. Called when the user first enables a typing feature.
#[tauri::command]
pub async fn typing_assist_ensure_ready(
    app: AppHandle,
    state: State<'_, Arc<TypingAssistState>>,
) -> Result<bool, String> {
    if state.is_ready() {
        return Ok(true);
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource dir: {e}"))?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::typing_assist::ensure_loaded(&st, &resource_dir)
    })
    .await
    .map_err(|e| format!("typing-assist load task failed: {e}"))??;
    Ok(true)
}

/// The best inline ghost suggestion for the text before the caret, or `None`.
/// Never errors — an unready engine simply yields no suggestion.
#[tauri::command]
pub fn typing_assist_query(
    state: State<'_, Arc<TypingAssistState>>,
    text_before_caret: String,
    want_completion: bool,
    want_next_word: bool,
) -> Option<GhostDto> {
    let engine = state.engine()?;
    let ghost: Ghost = engine.query(&text_before_caret, want_completion, want_next_word)?;
    Some(GhostDto {
        insert: ghost.insert,
        word: ghost.word,
        kind: match ghost.kind {
            GhostKind::Completion => "completion".into(),
            GhostKind::NextWord => "next_word".into(),
        },
    })
}

/// The correction for a finished word, or `None` to leave it alone.
#[tauri::command]
pub fn typing_assist_correct(
    state: State<'_, Arc<TypingAssistState>>,
    word: String,
    previous: String,
) -> Option<String> {
    state.engine()?.correct(&word, &previous)
}

/// Teach the lexicon a finished word (and its bigram with the previous word).
#[tauri::command]
pub fn typing_assist_learn(
    state: State<'_, Arc<TypingAssistState>>,
    previous: String,
    word: String,
) {
    if let Some(engine) = state.engine() {
        engine.learn(&previous, &word);
    }
}

/// The user reverted a correction — never correct that word again.
#[tauri::command]
pub fn typing_assist_undo_correct(
    state: State<'_, Arc<TypingAssistState>>,
    previous: String,
    original: String,
) {
    if let Some(engine) = state.engine() {
        engine.undo_correct(&previous, &original);
    }
}

/// Persist the personal lexicon to disk now (e.g. on window close / disable).
#[tauri::command]
pub fn typing_assist_flush(state: State<'_, Arc<TypingAssistState>>) {
    if let Some(engine) = state.engine() {
        engine.flush();
    }
}
