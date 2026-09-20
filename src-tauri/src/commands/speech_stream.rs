//! Tauri IPC for live dictation.
//!
//! Thin wrappers over [`crate::speech_stream`]. The composer calls `arm` once
//! before it needs the microphone, then `write` for every block of audio it
//! captures, then `stop`. Words come back on the event channels the module
//! documents, not as return values, because they arrive while `write` calls are
//! still happening.
//!
//! Audio crosses as base64 because Tauri's IPC is JSON. It is the same trade
//! [`super::speech`] already makes, just per block instead of once.

use base64::{engine::general_purpose, Engine as _};
use tauri::AppHandle;

use crate::speech_stream::{self, StreamConfig, StreamValidation};

/// Check the program, the model and the CUDA files without loading anything.
#[tauri::command]
pub async fn speech_stream_validate(config: StreamConfig) -> StreamValidation {
    speech_stream::validate(&config).await
}

/// Start a child and let it load the model. Returns the session id to use for
/// every later call. `speech_stream_ready` fires when it is actually listening.
#[tauri::command]
pub async fn speech_stream_arm(app: AppHandle, config: StreamConfig) -> Result<String, String> {
    speech_stream::arm(app, config).await
}

/// Send one block of captured audio: base64 of little-endian `f32` samples,
/// 16 kHz, mono.
#[tauri::command]
pub async fn speech_stream_write(session_id: String, pcm_base64: String) -> Result<(), String> {
    let pcm = general_purpose::STANDARD
        .decode(pcm_base64.as_bytes())
        .map_err(|error| format!("The captured audio could not be read: {error}"))?;
    if pcm.is_empty() {
        return Ok(());
    }
    if pcm.len() % 4 != 0 {
        return Err("The captured audio is not whole 32-bit samples.".to_string());
    }
    speech_stream::write_pcm(&session_id, &pcm).await
}

/// Stop recording and ask for the complete text. It arrives on
/// `speech_stream_final`, which includes the last words held back until now.
#[tauri::command]
pub async fn speech_stream_stop(session_id: String) -> Result<(), String> {
    speech_stream::stop(&session_id).await
}

/// Throw the recording away. Also how the idle timeout releases video memory.
#[tauri::command]
pub async fn speech_stream_cancel(session_id: String) -> Result<(), String> {
    speech_stream::cancel(&session_id).await
}

/// Stop every session. Called when the agent window closes.
#[tauri::command]
pub async fn speech_stream_shutdown() {
    speech_stream::shutdown_all().await;
}
