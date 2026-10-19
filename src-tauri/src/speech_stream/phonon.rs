//! The Phonon-2 engine: CrispASR's own streaming mode.
//!
//! [Phonon-2](https://huggingface.co/FermionResearch/Phonon-2) is an English
//! model derived from NVIDIA Parakeet TDT 0.6B v3, converted to GGUF for
//! CrispASR (`cstr/phonon2-GGUF`). It runs on the same `crispasr.exe` the
//! "On stop" path already uses, started with `--stream --stream-json`.
//!
//! ## How it differs from audio.cpp
//!
//! audio.cpp only ever adds words. CrispASR re-reads the open sentence on every
//! step and prints all of it again, so a word it already showed can change
//! ("settings for the" becomes "settings file and"). Each line is one event:
//!
//! ```text
//! {"type":"partial","utterance_id":1,"text":"Open the settings for the",...}  <- the open sentence now reads this
//! {"type":"final","utterance_id":1,"text":"Open the settings file and ...",...} <- that sentence is finished
//! {"type":"silence","t":12.0}                                                  <- nothing to do
//! ```
//!
//! A sentence ends on a pause only when CrispASR's voice detector is loaded
//! (`--vad`). Without it every pause is ignored and the whole recording stays
//! one open sentence until a 60 s cap, so the detector file is looked up and
//! passed explicitly; see [`find_vad_model`].
//!
//! ## Measured (RTX 4070 Ti SUPER, CUDA 13, q8_0, 2026-10-17)
//!
//! Model loaded and listening 0.8 s after start. A partial every 0.5 s of
//! audio, keeping up with real time over a one-minute live recording. With
//! `--vad`, each pause in a 25 s clip gave its own exact final sentence.

use std::path::{Path, PathBuf};

use tokio::process::Command;

use super::{StreamConfig, StreamValidation};

/// Re-read the open sentence every half second of audio.
const STEP_MS: u32 = 500;
/// How much of the open sentence each step re-reads. The default 10 s cut the
/// start off longer sentences in testing; 30 s kept them whole.
const WINDOW_MS: u32 = 30_000;

pub fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "crispasr.exe"
    } else {
        "crispasr"
    }
}

/// One line of output, in the terms the composer acts on.
#[derive(Debug, PartialEq, Eq)]
pub enum Update {
    /// The open sentence now reads this. Replace what was shown for it.
    Revise(String),
    /// The open sentence is finished and reads this. It will not change again.
    Commit(String),
}

/// Read one stdout line. Anything that is not a sentence update is `None`.
pub fn parse_line(line: &str) -> Option<Update> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let text = value.get("text")?.as_str()?.trim().to_string();
    match value.get("type")?.as_str()? {
        "partial" => Some(Update::Revise(text)),
        "final" => Some(Update::Commit(text)),
        _ => None,
    }
}

/// CrispASR prints this to stderr once the model is loaded and it is reading
/// audio. Nothing sent before it is lost (it waits in the pipe), but the
/// composer holds audio back until then so blocks are never queued in Rust.
pub fn is_ready_line(line: &str) -> bool {
    line.starts_with("crispasr[stream]: reading raw")
}

/// A fatal problem, worded by CrispASR itself, e.g.
/// `crispasr: error: failed to initialise backend 'phonon2'`.
///
/// Narrower than audio.cpp's check on purpose: CrispASR's normal startup
/// chatter includes library lines that mention "failed" for optional pieces.
pub fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("crispasr") && (lower.contains("error") || lower.contains("failed"))
}

/// The voice detector CrispASR uses to end a sentence on a pause.
///
/// CrispASR downloads `ggml-silero-*.bin` into `~/.cache/crispasr` the first
/// time `--vad` is used, and ignores `--cache-dir` when looking for it again,
/// so that is where it is found. A copy beside the program wins, for anyone who
/// keeps everything in one folder. The newest version by name is used.
pub fn find_vad_model(exe: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        dirs.push(dir.to_path_buf());
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".cache").join("crispasr"));
    }
    dirs.iter().find_map(|dir| newest_silero(dir))
}

fn newest_silero(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ggml-silero") && name.ends_with(".bin"))
        })
        .max()
}

/// The arguments after the program name.
pub fn args(config: &StreamConfig, vad_model: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--backend".into(),
        "phonon2".into(),
        "-m".into(),
        config.model_path.trim().into(),
        "--stream".into(),
        "--stream-json".into(),
        "--stream-step".into(),
        STEP_MS.to_string(),
        "--stream-length".into(),
        WINDOW_MS.to_string(),
    ];
    if let Some(vad) = vad_model {
        args.push("--vad".into());
        args.push("-vm".into());
        args.push(vad.to_string_lossy().into_owned());
    }
    // CrispASR picks CUDA by itself when its build has it. Only CPU needs saying.
    if config.backend.eq_ignore_ascii_case("cpu") {
        args.push("--no-gpu".into());
    }
    args
}

pub fn configure(command: &mut Command, config: &StreamConfig, exe: &Path) {
    command.args(args(config, find_vad_model(exe).as_deref()));
}

/// The browser hands us `f32` samples; CrispASR reads 16-bit integers.
pub fn f32le_to_s16le(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() / 2);
    for sample in pcm.chunks_exact(4) {
        let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
        let clamped = if value.is_finite() { value.clamp(-1.0, 1.0) } else { 0.0 };
        let scaled = (clamped * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&scaled.to_le_bytes());
    }
    out
}

/// Accept either `crispasr.exe` itself or the folder holding it, the same as
/// the "On stop" runtime folder.
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

/// Check the setup without loading the model.
pub fn validate(config: &StreamConfig) -> StreamValidation {
    let exe = resolve_executable(&config.runtime_path);
    let runtime_ok = exe.is_some();
    let model_ok = Path::new(config.model_path.trim()).is_file();
    let vad = exe.as_deref().and_then(find_vad_model);

    let message = if !runtime_ok {
        "Select the folder that contains crispasr.exe.".to_string()
    } else if !model_ok {
        "Select the Phonon-2 .gguf model file.".to_string()
    } else if vad.is_none() {
        "Live dictation is ready, but sentences will not end on a pause: CrispASR's voice \
         detector (ggml-silero) was not found. Run crispasr once with --vad to download it."
            .to_string()
    } else {
        "Live dictation is ready.".to_string()
    };

    StreamValidation {
        ready: runtime_ok && model_ok,
        runtime_ok,
        model_ok,
        executable_path: exe.map(|p| p.to_string_lossy().to_string()),
        missing_libraries: Vec::new(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> StreamConfig {
        StreamConfig {
            engine: "phonon".into(),
            runtime_path: String::new(),
            model_path: " E:/models/phonon2-q8_0.gguf ".into(),
            backend: "auto".into(),
            chunk_ms: 320,
            unfixed_tokens: 2,
            language: None,
            library_path: None,
        }
    }

    #[test]
    fn partial_revises_and_final_commits() {
        assert_eq!(
            parse_line(r#"{"type":"partial","utterance_id":1,"text":"Open the","t0":0.0,"t1":0.5}"#),
            Some(Update::Revise("Open the".into()))
        );
        assert_eq!(
            parse_line(r#"{"type":"final","utterance_id":1,"text":" Done. ","t0":0.0,"t1":2.0}"#),
            Some(Update::Commit("Done.".into()))
        );
    }

    #[test]
    fn silence_and_noise_are_not_updates() {
        assert_eq!(parse_line(r#"{"type":"silence","t":12.0}"#), None);
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("crispasr[stream]: reading raw s16le"), None);
    }

    #[test]
    fn ready_and_error_lines_are_recognised() {
        assert!(is_ready_line("crispasr[stream]: reading raw s16le 16kHz mono PCM from stdin"));
        assert!(!is_ready_line("crispasr[stream]: step=500ms length=30000ms keep=200ms"));
        assert!(is_error_line("crispasr: error: failed to initialise backend 'phonon2'"));
        // A warning CrispASR prints on every healthy start.
        assert!(!is_error_line(
            "ggml_cuda_init: CUDA minor version mismatch — compiled 13.0, runtime 13.4."
        ));
    }

    #[test]
    fn arguments_carry_the_model_and_the_voice_detector() {
        let args = args(&config(), Some(Path::new("C:/cache/ggml-silero-v6.2.0.bin")));
        let joined = args.join(" ");
        assert!(joined.starts_with("--backend phonon2 -m E:/models/phonon2-q8_0.gguf --stream --stream-json"));
        assert!(joined.contains("--stream-length 30000"));
        assert!(joined.contains("--vad -vm C:/cache/ggml-silero-v6.2.0.bin"));
        assert!(!joined.contains("--no-gpu"));
    }

    #[test]
    fn no_detector_means_no_vad_flag_and_cpu_means_no_gpu() {
        let mut c = config();
        c.backend = "cpu".into();
        let args = args(&c, None);
        assert!(!args.iter().any(|a| a == "--vad"));
        assert!(args.iter().any(|a| a == "--no-gpu"));
    }

    #[test]
    fn samples_convert_to_16_bit_and_clip() {
        let input: Vec<u8> = [0.0f32, 1.0, -1.0, 2.0, f32::NAN]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let out = f32le_to_s16le(&input);
        let samples: Vec<i16> = out
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(samples, vec![0, i16::MAX, -i16::MAX, i16::MAX, 0]);
    }

    #[test]
    fn newest_detector_file_wins() {
        let dir = std::env::temp_dir().join(format!("aurora-vad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ggml-silero-v5.1.2.bin"), b"x").unwrap();
        std::fs::write(dir.join("ggml-silero-v6.2.0.bin"), b"x").unwrap();
        std::fs::write(dir.join("ggml-silero-v6.2.0.bin.src"), b"x").unwrap();
        assert_eq!(newest_silero(&dir), Some(dir.join("ggml-silero-v6.2.0.bin")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
