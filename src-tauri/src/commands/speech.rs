use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::time;
use uuid::Uuid;

const BUNDLED_RUNTIME_SENTINEL: &str = "__bundled__";
const TARGET_SAMPLE_RATE: u32 = 16_000;
const SPEECH_COMMAND_TIMEOUT: Duration = Duration::from_secs(180);
/// The only speech engine. Aurora used to compile a second one in — Qwen3-ASR
/// through `candle-core` — which nobody used and which cost ~a third of the
/// binary plus a whole `cuda` cargo feature. Transcription is a child process
/// against the user's own CrispASR build, like every other local-model feature
/// in Aurora (see `prompt_refine`).
const CRISP_ENGINE: &str = "crispasr-gguf";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRuntimeRequest {
    pub engine: Option<String>,
    pub runtime_path: String,
    pub model_path: String,
    pub backend: Option<String>,
    pub device_preference: Option<String>,
    pub n_threads: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTranscribeRequest {
    pub engine: Option<String>,
    pub runtime_path: String,
    pub model_path: String,
    pub backend: Option<String>,
    pub device_preference: Option<String>,
    pub n_threads: Option<i32>,
    pub audio_pcm_base64: String,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechValidationResult {
    pub ready: bool,
    pub engine: String,
    pub runtime_ok: bool,
    pub model_ok: bool,
    pub library_path: Option<String>,
    pub available_backends: Vec<String>,
    pub cuda_compiled: bool,
    pub effective_device: String,
    pub gpu_available: bool,
    pub device_message: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTranscriptionResult {
    pub transcript: String,
    pub backend: String,
}

struct TempWav {
    path: PathBuf,
}

impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn runtime_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "crispasr.exe"
    } else {
        "crispasr"
    }
}

fn resolve_runtime_path(runtime_path: &str, _app: Option<&AppHandle>) -> Option<PathBuf> {
    let trimmed = runtime_path.trim();
    if trimmed.is_empty() || trimmed == BUNDLED_RUNTIME_SENTINEL {
        return None;
    }

    Some(PathBuf::from(trimmed))
}

fn resolve_executable(runtime_path: &str, app: Option<&AppHandle>) -> Option<PathBuf> {
    let path = resolve_runtime_path(runtime_path, app)?;
    let trimmed = runtime_path.trim();
    if !trimmed.is_empty() && trimmed != BUNDLED_RUNTIME_SENTINEL && path.is_file() {
        return Some(path);
    }

    let candidate = path.join(runtime_executable_name());
    candidate.is_file().then_some(candidate)
}

fn normalize_backend(backend: Option<&str>) -> String {
    let value = backend.unwrap_or("auto").trim().to_lowercase();
    if value.is_empty() {
        "auto".to_string()
    } else {
        value
    }
}

fn normalize_device(device_preference: Option<&str>) -> String {
    match device_preference
        .unwrap_or("auto")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "cpu" => "cpu".to_string(),
        "gpu" => "gpu".to_string(),
        _ => "auto".to_string(),
    }
}

fn normalize_threads(n_threads: Option<i32>) -> i32 {
    n_threads.unwrap_or(4).clamp(1, 32)
}

fn runtime_has_gpu_backend(executable_path: &Path) -> bool {
    executable_path
        .parent()
        .map(|parent| {
            parent.join("ggml-cuda.dll").is_file()
                || parent.join("libggml-cuda.so").is_file()
                || parent.join("libggml-metal.dylib").is_file()
        })
        .unwrap_or(false)
}

fn command_for_executable(executable_path: &Path) -> TokioCommand {
    let mut command = TokioCommand::new(executable_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(runtime_dir) = executable_path.parent() {
        command.current_dir(runtime_dir);
        let current_path = std::env::var("PATH").unwrap_or_default();
        let separator = if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        };
        command.env(
            "PATH",
            format!(
                "{}{}{}",
                runtime_dir.to_string_lossy(),
                separator,
                current_path
            ),
        );
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

async fn run_command(
    mut command: TokioCommand,
    timeout_message: &str,
) -> Result<(String, String), String> {
    let output = time::timeout(SPEECH_COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| timeout_message.to_string())?
        .map_err(|error| format!("Failed to run CrispASR: {}", error))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by the OS".to_string());
        return Err(if stderr.is_empty() {
            format!("CrispASR exited unexpectedly ({status}).")
        } else {
            format!("CrispASR exited unexpectedly ({status}): {stderr}")
        });
    }

    Ok((stdout, stderr))
}

fn parse_backends(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let first = line.split_whitespace().next()?;
            let is_backend = first.chars().any(|ch| ch.is_ascii_alphanumeric())
                && first
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
            if !is_backend {
                return None;
            }

            match first {
                "backend" | "Use" | "Language" | "natively" | "accept" | "crispasr" => None,
                name if line.contains(" Y ") || line.contains(" - ") => {
                    Some(name.replace('_', "-"))
                }
                _ => None,
            }
        })
        .collect()
}

async fn list_backends(executable_path: &Path) -> Result<Vec<String>, String> {
    let mut command = command_for_executable(executable_path);
    command.arg("--list-backends");
    let (stdout, stderr) = run_command(command, "CrispASR backend detection timed out.").await?;
    let mut backends = parse_backends(&stdout);
    if backends.is_empty() {
        backends = parse_backends(&stderr);
    }
    Ok(backends)
}

async fn validate_crisp_runtime(
    request: &SpeechRuntimeRequest,
    app: Option<&AppHandle>,
) -> SpeechValidationResult {
    let executable_path = resolve_executable(&request.runtime_path, app);
    let runtime_ok = executable_path.is_some();
    let model_path = PathBuf::from(request.model_path.trim());
    let model_ok = model_path.is_file();
    let backend = normalize_backend(request.backend.as_deref());
    let device = normalize_device(request.device_preference.as_deref());
    let cuda_compiled = false;

    let mut available_backends = Vec::new();
    let mut gpu_available = false;
    let mut message = String::new();
    let mut device_message =
        "CrispASR will use the best backend available in the selected runtime.".to_string();

    if let Some(path) = executable_path.as_ref() {
        gpu_available = runtime_has_gpu_backend(path);
        match list_backends(path).await {
            Ok(backends) => available_backends = backends,
            Err(error) => message = error,
        }
    }

    if message.is_empty() {
        if !runtime_ok {
            message = "Select the folder that contains crispasr.exe.".to_string();
        } else if !model_ok {
            message = "Select a local GGUF ASR model file.".to_string();
        } else if backend != "auto"
            && !available_backends.is_empty()
            && !available_backends.contains(&backend)
        {
            message = format!(
                "The selected backend '{}' is not available in this CrispASR runtime.",
                backend
            );
        } else if device == "gpu" && !gpu_available {
            message = "GPU mode is selected, but the selected runtime does not include a GPU backend library.".to_string();
        } else {
            message = "Speech input is ready.".to_string();
        }
    }

    if device == "cpu" {
        device_message =
            "Aurora will pass --no-gpu to CrispASR for this transcription.".to_string();
    } else if device == "gpu" {
        device_message = "Aurora will use the selected GPU-capable CrispASR runtime.".to_string();
    }

    let backend_ok =
        backend == "auto" || available_backends.is_empty() || available_backends.contains(&backend);
    let device_ok = device != "gpu" || gpu_available;
    let ready =
        runtime_ok && model_ok && backend_ok && device_ok && message == "Speech input is ready.";
    let effective_device = if gpu_available && device != "cpu" {
        "gpu".to_string()
    } else {
        "cpu".to_string()
    };

    SpeechValidationResult {
        ready,
        engine: CRISP_ENGINE.to_string(),
        runtime_ok,
        model_ok,
        library_path: executable_path.map(|path| path.to_string_lossy().to_string()),
        available_backends,
        cuda_compiled,
        effective_device,
        gpu_available,
        device_message,
        message,
    }
}

async fn validate_runtime(
    request: &SpeechRuntimeRequest,
    app: Option<&AppHandle>,
) -> SpeechValidationResult {
    validate_crisp_runtime(request, app).await
}

fn decode_pcm(base64_pcm: &str) -> Result<Vec<f32>, String> {
    let bytes = general_purpose::STANDARD
        .decode(base64_pcm.as_bytes())
        .map_err(|error| format!("Recorded audio could not be decoded: {}", error))?;

    if bytes.len() < 4 || bytes.len() % 4 != 0 {
        return Err("Recorded audio is empty or malformed.".to_string());
    }

    let mut pcm = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(pcm)
}

fn clamp_sample(sample: f32) -> i16 {
    let normalized = sample.clamp(-1.0, 1.0);
    (normalized * i16::MAX as f32) as i16
}

fn write_temp_wav(pcm: &[f32]) -> Result<TempWav, String> {
    if pcm.is_empty() {
        return Err("Recorded audio is empty.".to_string());
    }

    let path = std::env::temp_dir().join(format!("aurora-speech-{}.wav", Uuid::new_v4()));
    let mut file = File::create(&path)
        .map_err(|error| format!("Failed to create temporary speech WAV: {}", error))?;

    let data_size = (pcm.len() * 2) as u32;
    let byte_rate = TARGET_SAMPLE_RATE * 2;
    let block_align = 2u16;
    file.write_all(b"RIFF")
        .and_then(|_| file.write_all(&(36 + data_size).to_le_bytes()))
        .and_then(|_| file.write_all(b"WAVEfmt "))
        .and_then(|_| file.write_all(&16u32.to_le_bytes()))
        .and_then(|_| file.write_all(&1u16.to_le_bytes()))
        .and_then(|_| file.write_all(&1u16.to_le_bytes()))
        .and_then(|_| file.write_all(&TARGET_SAMPLE_RATE.to_le_bytes()))
        .and_then(|_| file.write_all(&byte_rate.to_le_bytes()))
        .and_then(|_| file.write_all(&block_align.to_le_bytes()))
        .and_then(|_| file.write_all(&16u16.to_le_bytes()))
        .and_then(|_| file.write_all(b"data"))
        .and_then(|_| file.write_all(&data_size.to_le_bytes()))
        .map_err(|error| format!("Failed to write temporary speech WAV header: {}", error))?;

    for sample in pcm {
        file.write_all(&clamp_sample(*sample).to_le_bytes())
            .map_err(|error| format!("Failed to write temporary speech WAV: {}", error))?;
    }

    Ok(TempWav { path })
}

async fn transcribe_crisp(
    request: SpeechTranscribeRequest,
    validation: SpeechValidationResult,
    pcm: Vec<f32>,
) -> Result<SpeechTranscriptionResult, String> {
    let executable_path = validation
        .library_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "CrispASR runtime is not configured.".to_string())?;
    let backend = normalize_backend(request.backend.as_deref());
    let device = normalize_device(request.device_preference.as_deref());
    let threads = normalize_threads(request.n_threads);
    let wav = write_temp_wav(&pcm)?;

    let mut command = command_for_executable(&executable_path);
    if backend != "auto" {
        command.arg("--backend").arg(&backend);
    }
    command
        .arg("-m")
        .arg(request.model_path.trim())
        .arg("-f")
        .arg(&wav.path)
        .arg("-t")
        .arg(threads.to_string())
        .arg("-nt");

    if device == "cpu" {
        command.arg("--no-gpu");
    }

    if let Some(language) = request.language.as_deref().map(str::trim) {
        if !language.is_empty() && language != "auto" {
            command.arg("-l").arg(language);
        }
    }

    let (stdout, _stderr) = run_command(command, "CrispASR transcription timed out.").await?;
    let transcript = stdout.trim().to_string();
    if transcript.is_empty() {
        return Err("CrispASR completed but did not return a transcript.".to_string());
    }

    Ok(SpeechTranscriptionResult {
        transcript,
        backend,
    })
}

#[tauri::command]
pub async fn speech_validate_config(
    app: AppHandle,
    request: SpeechRuntimeRequest,
) -> Result<SpeechValidationResult, String> {
    Ok(validate_runtime(&request, Some(&app)).await)
}

#[tauri::command]
pub async fn speech_transcribe_pcm(
    app: AppHandle,
    request: SpeechTranscribeRequest,
) -> Result<SpeechTranscriptionResult, String> {
    let validation = validate_runtime(
        &SpeechRuntimeRequest {
            engine: request.engine.clone(),
            runtime_path: request.runtime_path.clone(),
            model_path: request.model_path.clone(),
            backend: request.backend.clone(),
            device_preference: request.device_preference.clone(),
            n_threads: request.n_threads,
        },
        Some(&app),
    )
    .await;

    if !validation.ready {
        return Err(validation.message);
    }

    let pcm = decode_pcm(&request.audio_pcm_base64)?;
    transcribe_crisp(request, validation, pcm).await
}

/// Install Aurora's native WebView microphone auto-grant handler on the agent
/// window's WebView.
///
/// The IDE main window gets this at startup (see `lib.rs::setup`), but the agent
/// window is usually created on demand from the frontend (`openAgentWindow` →
/// `new WebviewWindow(...)`), a path that never runs the Rust-side install. Without
/// it, the agent window's first `getUserMedia` call makes WebView2 (Windows) show
/// its own "…wants to use your microphone" prompt on top of Aurora's in-app gate,
/// which looks broken. The agent window calls this once on boot so its own
/// in-app modal is the only microphone prompt the user ever sees.
///
/// Best-effort and safe to call more than once: registering the handler twice is
/// harmless (WebView2 stops dispatching after the first sets an explicit state),
/// and a missing window or unsupported platform simply no-ops.
#[tauri::command]
pub fn install_agent_media_permission_handler(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    match app.get_webview_window("agent-window") {
        Some(window) => {
            // The JS-created agent window misses every Rust-side install
            // that build-time windows get, so this command is its one
            // native-handler bootstrap: piggyback the renderer-crash
            // auto-reload handler (best-effort) alongside the mic grant.
            if let Err(err) =
                crate::services::webview_recovery::install_crash_recovery_handler(&window)
            {
                eprintln!("[aurora] failed to install webview crash recovery (agent): {err}");
            }
            crate::services::webview_permissions::install_permission_handler(&window)
        }
        None => Ok(()),
    }
}
