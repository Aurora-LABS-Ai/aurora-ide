//! Prompt refinement for the Agent Window composer.
//!
//! An OPTIONAL, fully-local feature: the user points Aurora at a prebuilt
//! llama.cpp folder (the `llama-completion.exe` + its DLLs) and a small GGUF
//! model (e.g. Qwen2.5-0.5B-Instruct). Clicking the ✦ refine button in the
//! composer runs the model once over the typed prompt and rewrites it clearer
//! WITHOUT changing intent.
//!
//! We deliberately shell out to the user's own `llama-completion.exe` rather
//! than linking a crate: it reuses their existing CUDA build, needs no C++
//! build in our pipeline, reads the GGUF's embedded tokenizer natively (no
//! side files), and has no server/port to manage — each refine is a ~1s
//! one-shot child process.
//!
//! The exact invocation (validated against llama.cpp b9957) is:
//!   llama-completion -m MODEL --jinja -sys SYS -p TEXT -st \
//!     --no-display-prompt --color off -n N -c 4096 -ngl NGL --no-warmup
//! stdout carries ONLY the refined text (+ a trailing "[end of text]" we strip);
//! all logs go to stderr; `-st` makes it exit cleanly instead of going
//! interactive.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The one-shot completion binary we drive (modern llama.cpp split `llama-cli`
/// into an interactive tool and this non-interactive one).
const COMPLETION_EXE: &str = "llama-completion.exe";
/// llama.cpp prints this after the generation in `-st` mode.
const EOT_MARKER: &str = "[end of text]";

/// Model context window (tokens). 8192 leaves ample room for the system prompt
/// + a long prompt + its rewrite well within a small model's context.
const CONTEXT_TOKENS: &str = "8192";

/// Hard cap on the prompt we'll refine. A refine is for an instruction, not a
/// data dump — anything larger (a pasted console log, a whole file) is rejected
/// so we never overflow the context or waste time. The composer disables the
/// button past this too; this is the backend safety net. ~8k chars ≈ ~2k tokens.
pub const MAX_INPUT_CHARS: usize = 8000;

/// The refiner's instruction. Tuned to preserve intent + all concrete details
/// (paths, @mentions, code) and emit ONLY the rewritten prompt.
const REFINE_SYSTEM: &str = "You are a prompt refiner for a coding agent. Rewrite the user's message into a clearer, more precise, well-structured prompt WITHOUT changing its core intent, requested outcome, or scope. Preserve every concrete detail exactly as written: file paths, @mentions, code, identifiers, numbers, URLs, and constraints. Keep the user's original language. Improve only grammar, clarity, structure, and specificity. Do NOT answer, execute, or expand the request, and do NOT add requirements the user did not state. Output ONLY the refined prompt text — no preamble, no quotes, no commentary, no code fences.";

/// User configuration (mirrors the Preferences UI).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineConfig {
    /// Folder containing `llama-completion.exe` + its DLLs.
    pub llama_dir: String,
    /// Path to the `.gguf` model.
    pub model_path: String,
    /// `"gpu"` (offload all layers) or `"cpu"`.
    #[serde(default = "default_device")]
    pub device: String,
    /// Max tokens to generate (EOS usually stops sooner).
    #[serde(default = "default_n_predict")]
    pub n_predict: u32,
}

fn default_device() -> String {
    "gpu".to_string()
}
fn default_n_predict() -> u32 {
    1024
}

/// Result of validating a config (mirrors the Speech tab's shape).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineValidation {
    pub ready: bool,
    pub completion_ok: bool,
    pub model_ok: bool,
    pub message: String,
}

/// Tracks in-flight child processes so a refine can be cancelled by id.
#[derive(Default)]
pub struct RefineState {
    running: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl RefineState {
    fn register(&self, id: &str, child: Arc<Mutex<Child>>) {
        self.running.lock().insert(id.to_string(), child);
    }
    fn unregister(&self, id: &str) {
        self.running.lock().remove(id);
    }
    /// Kill an in-flight refine. Returns true if one was found.
    pub fn cancel(&self, id: &str) -> bool {
        if let Some(child) = self.running.lock().remove(id) {
            let _ = child.lock().kill();
            true
        } else {
            false
        }
    }
}

/// Resolve the completion exe inside the configured folder (accept a folder or a
/// direct path to the exe).
fn resolve_completion(llama_dir: &str) -> Option<PathBuf> {
    let p = PathBuf::from(llama_dir);
    if p.is_file() {
        return Some(p);
    }
    let exe = p.join(COMPLETION_EXE);
    exe.is_file().then_some(exe)
}

/// Validate that the binary + model exist and look usable.
pub fn validate(config: &RefineConfig) -> RefineValidation {
    let completion = resolve_completion(&config.llama_dir);
    let completion_ok = completion.is_some();
    let model_ok = Path::new(&config.model_path).is_file();

    let message = if !completion_ok {
        format!("{COMPLETION_EXE} not found in the llama.cpp folder.")
    } else if !model_ok {
        "Model .gguf file not found.".to_string()
    } else {
        let dev = if config.device == "cpu" { "CPU" } else { "GPU" };
        format!("Ready — refine will run on {dev}.")
    };

    RefineValidation {
        ready: completion_ok && model_ok,
        completion_ok,
        model_ok,
        message,
    }
}

/// Run one refinement. Blocking — call from `spawn_blocking`. Registers the
/// child under `request_id` so it can be cancelled mid-flight.
pub fn refine(
    state: &RefineState,
    request_id: &str,
    text: &str,
    config: &RefineConfig,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to refine".to_string());
    }
    // Guard against data-dump inputs that would overflow the model context.
    if text.chars().count() > MAX_INPUT_CHARS {
        return Err(format!(
            "Prompt is too long to refine (over {MAX_INPUT_CHARS} characters). Refine is for instructions, not large pastes."
        ));
    }

    let exe = resolve_completion(&config.llama_dir)
        .ok_or_else(|| format!("{COMPLETION_EXE} not found in the configured folder"))?;
    if !Path::new(&config.model_path).is_file() {
        return Err("model .gguf not found".to_string());
    }

    let ngl = if config.device == "cpu" { "0" } else { "99" };
    let n_predict = config.n_predict.clamp(16, 4096).to_string();

    let mut command = Command::new(&exe);
    command
        .args([
            "-m",
            &config.model_path,
            "--jinja", // apply the GGUF's embedded chat template
            "-sys",
            REFINE_SYSTEM,
            "-p",
            text,
            "-st",                 // single turn → exit cleanly, no interactive hang
            "--no-display-prompt", // stdout = only the completion
            "--color",
            "off",
            "-n",
            &n_predict,
            "-c",
            CONTEXT_TOKENS,
            "-ngl",
            ngl,
            "--no-warmup",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    // Don't flash a console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch {COMPLETION_EXE}: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout from llama-completion".to_string())?;

    let child = Arc::new(Mutex::new(child));
    state.register(request_id, child.clone());

    // Read stdout to completion (kill on cancel makes this hit EOF).
    let mut out = String::new();
    let read_result = stdout.read_to_string(&mut out);

    let status = child.lock().wait();
    state.unregister(request_id);

    read_result.map_err(|e| format!("reading model output failed: {e}"))?;

    // A killed process → treat as cancellation.
    if let Ok(st) = status {
        if !st.success() && out.trim().is_empty() {
            return Err("refine cancelled".to_string());
        }
    }

    Ok(clean_output(&out))
}

/// Strip the trailing `[end of text]` marker + surrounding whitespace, and drop
/// a wrapping pair of quotes if the model added them despite instructions.
fn clean_output(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(idx) = s.rfind(EOT_MARKER) {
        s = s[..idx].trim_end();
    }
    let s = s.trim();
    // Remove a single pair of surrounding quotes.
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let (a, b) = (bytes[0], bytes[bytes.len() - 1]);
        if (a == b'"' && b == b'"') || (a == b'\'' && b == b'\'') {
            return s[1..s.len() - 1].trim().to_string();
        }
    }
    s.to_string()
}
