//! Live dictation — words appear in the composer while you speak.
//!
//! The existing [`crate::commands::speech`] records everything first and
//! transcribes once at the end. It cannot stream: it writes a temp WAV, runs
//! CrispASR to completion and returns one string. So this is a second module
//! rather than a flag on that one. Both stay. The user picks "On stop" or
//! "As I speak" in Preferences › Voice input.
//!
//! ## What runs
//!
//! [audio.cpp](https://github.com/0xShug0/audio.cpp) running NetEase Youdao's
//! Confucius4-R2T2. Like every other local model in Aurora it is the user's own
//! build, run as a child process — the same way `prompt_refine` drives
//! llama.cpp and `speech` drives CrispASR. Aurora ships no weights.
//!
//! ## How we talk to it
//!
//! One child per recording, started with `--mode streaming --audio -`.
//! Microphone audio goes to its stdin as 16 kHz mono `f32`, which is exactly
//! what the browser already gives us, so nothing is converted. Because we read
//! its output through a pipe instead of a terminal, it prints one line per
//! update:
//!
//! ```text
//! audio_input=stdin format=f32le rate=16000 channels=1   <- model is loaded, listening
//! partial_text=Some call me                              <- new words
//! partial_text= nature, others                           <- more new words
//! text_output=Some call me nature, others call me ...    <- the whole thing, on close
//! ```
//!
//! Each `partial_text` is only what is new, so they join end to end. Closing
//! stdin ends the recording.
//!
//! The model holds back the last word or two until the next moment of audio
//! confirms them, so those arrive only in `text_output` when you stop. That is
//! why the composer replaces its text with `text_output` at the end instead of
//! just appending.
//!
//! ## Why a child is started early
//!
//! Loading the 2.31 GiB model takes about 3.5 seconds, which is far too long to
//! wait after clicking record. So a child is started ahead of time and a fresh
//! one after each recording. It holds that much video memory while it waits, so
//! an idle timeout the user sets releases it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

/// The model is loaded and listening.
pub const EVENT_READY: &str = "speech_stream_ready";
/// New words. These join end to end.
pub const EVENT_PARTIAL: &str = "speech_stream_partial";
/// The complete text, including the last words held back until you stopped.
pub const EVENT_FINAL: &str = "speech_stream_final";
/// Something went wrong, in words a person can act on.
pub const EVENT_ERROR: &str = "speech_stream_error";

/// The model family name this module knows the option names for.
const FAMILY: &str = "confucius4_r2t2";
/// The model reads 16 kHz mono.
const TARGET_SAMPLE_RATE: u32 = 16_000;
/// How long to wait for the final text after we stop sending audio.
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(60);

fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "audiocpp_cli.exe"
    } else {
        "audiocpp_cli"
    }
}

/// Everything the child needs. One field per row in Preferences › Voice input.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfig {
    /// `audiocpp_cli` itself, or the folder holding it.
    pub runtime_path: String,
    /// The `.gguf` model file. Q8_0 or better; smaller ones are refused on load.
    pub model_path: String,
    /// `cuda`, `vulkan`, `cpu`, or `auto`.
    #[serde(default = "default_backend")]
    pub backend: String,
    /// How much audio the model chews at a time, 80-2000 ms. Smaller is faster
    /// to react and slightly less accurate.
    #[serde(default = "default_chunk_ms")]
    pub chunk_ms: u32,
    /// How many words the model keeps to itself until it is sure of them. Lower
    /// shows text sooner but risks a wrong word being kept, because text it has
    /// already shown is never taken back.
    #[serde(default = "default_unfixed_tokens")]
    pub unfixed_tokens: u32,
    /// A language the model knows, or `auto`/empty to let it work it out.
    #[serde(default)]
    pub language: Option<String>,
    /// An extra folder to put on the child's PATH. CUDA 13 keeps its runtime
    /// files in `bin\x64` rather than `bin`, and without them the program dies
    /// the moment it starts, with no message at all.
    #[serde(default)]
    pub library_path: Option<String>,
}

fn default_backend() -> String {
    "auto".to_string()
}
fn default_chunk_ms() -> u32 {
    320
}
fn default_unfixed_tokens() -> u32 {
    2
}

impl StreamConfig {
    fn chunk_ms_clamped(&self) -> u32 {
        self.chunk_ms.clamp(80, 2000)
    }

    fn unfixed_clamped(&self) -> u32 {
        self.unfixed_tokens.clamp(1, 16)
    }

    fn language_arg(&self) -> Option<&str> {
        let value = self.language.as_deref()?.trim();
        if value.is_empty() || value.eq_ignore_ascii_case("auto") {
            None
        } else {
            Some(value)
        }
    }
}

/// What a setup check found. Every field is something the panel can say out loud.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamValidation {
    pub ready: bool,
    pub runtime_ok: bool,
    pub model_ok: bool,
    pub executable_path: Option<String>,
    pub missing_libraries: Vec<String>,
    pub message: String,
}

/// Accept either the program itself or the folder holding it.
pub fn resolve_executable(runtime_path: &str) -> Option<PathBuf> {
    let trimmed = runtime_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        return Some(path);
    }
    let candidate = path.join(executable_name());
    candidate.is_file().then_some(candidate)
}

/// CUDA files the program needs but cannot find on its own.
#[cfg(target_os = "windows")]
fn missing_cuda_libraries(config: &StreamConfig, exe: &Path) -> Vec<String> {
    if !config.backend.eq_ignore_ascii_case("cuda") {
        return Vec::new();
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        roots.push(dir.to_path_buf());
    }
    if let Some(extra) = config.library_path.as_deref().map(str::trim) {
        if !extra.is_empty() {
            roots.push(PathBuf::from(extra));
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        roots.extend(std::env::split_paths(&path));
    }

    // The file name carries the CUDA version, so check the ones in use.
    let wanted = ["cudart64_13.dll", "cudart64_12.dll"];
    let found = wanted
        .iter()
        .any(|lib| roots.iter().any(|root| root.join(lib).is_file()));
    if found {
        Vec::new()
    } else {
        vec!["cudart64_13.dll".to_string()]
    }
}

#[cfg(not(target_os = "windows"))]
fn missing_cuda_libraries(_config: &StreamConfig, _exe: &Path) -> Vec<String> {
    Vec::new()
}

/// Check the setup without loading the model, so the panel can answer in
/// milliseconds instead of seconds.
///
/// This checks what it can actually know: the program is there, the model file
/// is there, and on GPU the CUDA files can be found. It deliberately does not
/// try to work out whether the build includes this model.
///
/// There is no way to ask it. `--list-loaders` looks like the answer and is
/// not: it wants a model spec beside the program, and the published `.gguf`
/// carries its spec inside the file instead, so a build that transcribes
/// perfectly well fails that command. Guessing from it reported a broken setup
/// for a working one. A build without the model fails when a recording starts,
/// with the program's own message, which is late but true.
pub async fn validate(config: &StreamConfig) -> StreamValidation {
    let exe = resolve_executable(&config.runtime_path);
    let runtime_ok = exe.is_some();
    let model_path = PathBuf::from(config.model_path.trim());
    let model_ok = model_path.is_file();

    let missing = match exe.as_ref() {
        Some(path) => missing_cuda_libraries(config, path),
        None => Vec::new(),
    };

    let message = if !runtime_ok {
        "Select audiocpp_cli.exe, or the folder that contains it.".to_string()
    } else if !model_ok {
        "Select the Confucius4-R2T2 .gguf model file.".to_string()
    } else if !missing.is_empty() {
        format!(
            "The CUDA files were not found ({}). CUDA 13 keeps them in the toolkit's bin\\x64 \
             folder — point 'CUDA folder' at it, or set Device to CPU.",
            missing.join(", ")
        )
    } else {
        "Live dictation is ready.".to_string()
    };

    StreamValidation {
        ready: runtime_ok && model_ok && missing.is_empty(),
        runtime_ok,
        model_ok,
        executable_path: exe.map(|p| p.to_string_lossy().to_string()),
        missing_libraries: missing,
        message,
    }
}

fn base_command(exe: &Path, library_path: Option<&str>) -> Command {
    let mut command = Command::new(exe);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Run from the program's own folder and put it, plus any extra folder, at
    // the front of PATH so the files next to it are found the way they are in a
    // terminal.
    let mut prefix: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
        prefix.push(dir.to_path_buf());
    }
    if let Some(extra) = library_path.map(str::trim) {
        if !extra.is_empty() {
            prefix.insert(0, PathBuf::from(extra));
        }
    }
    if !prefix.is_empty() {
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = prefix;
        paths.extend(std::env::split_paths(&existing));
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // tokio's Command carries `creation_flags` itself, so no trait import
        // here — same as `commands::speech`.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

/// One child, either waiting or recording.
struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<AsyncMutex<Session>>>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: String,
    text: String,
}

fn emit(app: &AppHandle, event: &str, session_id: &str, text: String) {
    let _ = app.emit(
        event,
        SessionEvent {
            session_id: session_id.to_string(),
            text,
        },
    );
}

/// Start a child and let it load the model. Returns as soon as the program
/// starts; [`EVENT_READY`] follows when it is actually listening.
pub async fn arm(app: AppHandle, config: StreamConfig) -> Result<String, String> {
    let exe = resolve_executable(&config.runtime_path)
        .ok_or_else(|| "audiocpp_cli was not found at the configured path.".to_string())?;
    let model = config.model_path.trim();
    if !Path::new(model).is_file() {
        return Err("The model file was not found at the configured path.".to_string());
    }

    let session_id = format!("speech-{}", uuid::Uuid::new_v4());

    let mut command = base_command(&exe, config.library_path.as_deref());
    command
        .arg("--task")
        .arg("asr")
        .arg("--mode")
        .arg("streaming")
        .arg("--family")
        .arg(FAMILY)
        .arg("--model")
        .arg(model)
        .arg("--backend")
        .arg(config.backend.trim())
        .arg("--audio")
        .arg("-")
        .arg("--input-format")
        .arg("f32le")
        .arg("--input-rate")
        .arg(TARGET_SAMPLE_RATE.to_string())
        .arg("--input-channels")
        .arg("1")
        .arg("--session-option")
        .arg(format!(
            "{FAMILY}.chunk_size_ms={}",
            config.chunk_ms_clamped()
        ))
        .arg("--session-option")
        .arg(format!(
            "{FAMILY}.unfixed_token_num={}",
            config.unfixed_clamped()
        ));
    if let Some(language) = config.language_arg() {
        command.arg("--language").arg(language);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start audiocpp_cli: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "audiocpp_cli produced no output.".to_string())?;
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    let session = Arc::new(AsyncMutex::new(Session { child, stdin }));
    registry()
        .lock()
        .map_err(|_| "The dictation session list is in a bad state.".to_string())?
        .sessions
        .insert(session_id.clone(), session);

    // The words, and the final text.
    {
        let app = app.clone();
        let id = session_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(delta) = line.strip_prefix("partial_text=") {
                    emit(&app, EVENT_PARTIAL, &id, delta.to_string());
                } else if line.starts_with("audio_input=stdin") {
                    emit(&app, EVENT_READY, &id, String::new());
                } else if let Some(final_text) = line.strip_prefix("text_output=") {
                    emit(&app, EVENT_FINAL, &id, final_text.to_string());
                }
            }
        });
    }

    // Progress chatter, and the only place a fatal startup problem shows up.
    if let Some(stderr) = stderr {
        let app = app.clone();
        let id = session_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let lower = line.to_lowercase();
                if lower.contains("error") || lower.contains("fatal") || lower.contains("failed") {
                    emit(&app, EVENT_ERROR, &id, line);
                }
            }
        });
    }

    Ok(session_id)
}

fn take_session(session_id: &str) -> Option<Arc<AsyncMutex<Session>>> {
    registry().lock().ok()?.sessions.remove(session_id)
}

fn get_session(session_id: &str) -> Option<Arc<AsyncMutex<Session>>> {
    registry().lock().ok()?.sessions.get(session_id).cloned()
}

/// Send captured audio. `pcm` is plain little-endian `f32` at 16 kHz, mono —
/// the exact bytes the browser already holds, so nothing is re-encoded.
pub async fn write_pcm(session_id: &str, pcm: &[u8]) -> Result<(), String> {
    let session = get_session(session_id)
        .ok_or_else(|| "That dictation session is no longer running.".to_string())?;
    let mut guard = session.lock().await;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or_else(|| "That dictation session is no longer taking audio.".to_string())?;
    stdin
        .write_all(pcm)
        .await
        .map_err(|error| format!("Could not send audio to the transcriber: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Could not send audio to the transcriber: {error}"))
}

/// Stop recording. Closing stdin makes the program finish up, print the whole
/// text and exit; [`EVENT_FINAL`] carries it.
pub async fn stop(session_id: &str) -> Result<(), String> {
    let session = get_session(session_id)
        .ok_or_else(|| "That dictation session is no longer running.".to_string())?;
    {
        let mut guard = session.lock().await;
        if let Some(mut stdin) = guard.stdin.take() {
            let _ = stdin.shutdown().await;
        }
    }

    // Clean up after it exits, but not before — dropping the session here would
    // kill the child before it printed the final text.
    let id = session_id.to_string();
    tokio::spawn(async move {
        if let Some(session) = get_session(&id) {
            let mut guard = session.lock().await;
            let _ = tokio::time::timeout(FINALIZE_TIMEOUT, guard.child.wait()).await;
        }
        let _ = take_session(&id);
    });
    Ok(())
}

/// Throw the recording away. Used by cancel and by the idle timeout.
pub async fn cancel(session_id: &str) -> Result<(), String> {
    let Some(session) = take_session(session_id) else {
        return Ok(()); // already gone; cancelling twice is fine
    };
    let mut guard = session.lock().await;
    guard.stdin.take();
    let _ = guard.child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), guard.child.wait()).await;
    Ok(())
}

/// Stop everything. Called on window close so no child outlives Aurora.
pub async fn shutdown_all() {
    let ids: Vec<String> = registry()
        .lock()
        .map(|reg| reg.sessions.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = cancel(&id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> StreamConfig {
        StreamConfig {
            runtime_path: String::new(),
            model_path: String::new(),
            backend: "cuda".into(),
            chunk_ms: 320,
            unfixed_tokens: 2,
            language: None,
            library_path: None,
        }
    }

    #[test]
    fn chunk_size_is_kept_inside_what_the_model_accepts() {
        let mut c = config();
        c.chunk_ms = 10;
        assert_eq!(c.chunk_ms_clamped(), 80);
        c.chunk_ms = 9_000;
        assert_eq!(c.chunk_ms_clamped(), 2000);
        c.chunk_ms = 320;
        assert_eq!(c.chunk_ms_clamped(), 320);
    }

    #[test]
    fn the_model_is_never_asked_to_hold_back_nothing() {
        // Zero tells it to show words it has not checked yet, and it then
        // contradicts itself. One is the floor.
        let mut c = config();
        c.unfixed_tokens = 0;
        assert_eq!(c.unfixed_clamped(), 1);
    }

    #[test]
    fn auto_and_blank_mean_work_out_the_language() {
        let mut c = config();
        assert_eq!(c.language_arg(), None);
        c.language = Some("  ".into());
        assert_eq!(c.language_arg(), None);
        c.language = Some("Auto".into());
        assert_eq!(c.language_arg(), None);
        c.language = Some("English".into());
        assert_eq!(c.language_arg(), Some("English"));
    }

    #[test]
    fn a_missing_path_finds_no_program() {
        assert!(resolve_executable("").is_none());
        assert!(resolve_executable("   ").is_none());
        assert!(resolve_executable("Z:\\nope\\audiocpp_cli.exe").is_none());
    }
}
