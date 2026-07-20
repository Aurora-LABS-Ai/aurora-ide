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
//! The exact invocation (validated against llama.cpp b10068) is:
//!   llama-completion -m MODEL -no-cnv -p CHATML_PROMPT \
//!     --no-display-prompt --color off -n N -c 8192 -ngl NGL --no-warmup
//! where CHATML_PROMPT is the conversation formatted by US in ChatML (the
//! Qwen family's template). We deliberately do NOT use `--jinja -sys … -st`
//! conversation mode: Qwen3.5's embedded chat template (which auto-opens a
//! `<think>` block) hard-crashes llama-completion's conversation path
//! (0xC0000409 right after system_info, b9957 AND b10068), while raw
//! `-no-cnv` completion works perfectly. For Qwen3-family models the
//! assistant turn is prefilled with an empty `<think></think>` block — the
//! standard switch that skips thinking for a one-shot task.
//! stdout carries ONLY the completion (+ a trailing "[end of text]" we strip);
//! all logs go to stderr.

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

/// The chat-title instruction, for the SAME local model. Few-shot examples are
/// what make a 0.5B model produce consistent noun-phrase titles (smoke-tested
/// against qwen2.5-0.5b-instruct: instruction-only output echoed the message
/// verbatim in lowercase; with examples it writes real titles).
const TITLE_SYSTEM: &str = "You create titles for chat conversations in a coding tool. Write a short noun-phrase title for the topic of the user's message: at most 6 words, first word capitalized, no punctuation at all, no quotes, same language as the message. Never answer or solve the message.\n\nExample message: my login form crashes when i submit empty fields\nTitle: Login form crash on empty submit\n\nExample message: add dark mode toggle to the settings page\nTitle: Dark mode toggle for settings\n\nExample message: why is npm install so slow on my laptop\nTitle: Slow npm install investigation\n\nOutput ONLY the title.";

/// Dictation-cleanup instruction. The before→after example pair is required:
/// without it the model only deletes "um"/"uh" and leaves everything else raw.
const DICTATION_SYSTEM: &str = "You rewrite voice dictation transcripts into clean written text for a coding tool. Add punctuation and capitalization, fix grammar, split into sentences, and remove filler words (um, uh, you know, I mean, so basically, like). Keep every technical term, file name, path, and number. Never answer the request, never summarize, never add new content, never change the meaning. Keep the person's language.\n\nExample transcript: so um i think we should uh probably change the api endpoint you know to use post instead of get\nCleaned: I think we should change the API endpoint to use POST instead of GET.\n\nExample transcript: okay so the login page it has a bug like when i type a wrong password it just uh shows nothing no error message\nCleaned: The login page has a bug. When I type a wrong password, it shows nothing - no error message.\n\nOutput ONLY the cleaned text.";

/// Reply-suggestion instruction — the "both sides" pattern (user-designed)
/// with two full worked examples. Harness-tested on Qwen3.5-0.8B against the
/// real example.txt exchange: this few-shot version scored a perfect 4.0
/// chips / 4.0 grounded over repeated runs, vs 1.7/1.0 for the
/// instruction-only version (which even degenerated to "No action" x3).
/// Worked examples are what make a small model produce short, anchored,
/// user-voice replies. Input is plain-text (markdown stripped); output is
/// parsed per-line, filtered, and deduped, so 1-4 chips may survive.
const SUGGEST_SYSTEM: &str = "You write one-tap reply suggestions for a developer chatting with an AI coding assistant. Given the developer's message and the assistant's reply, produce the 4 most useful messages the developer might tap next. Short (max 8 words), in the developer's voice, each a different intent, each anchored to something specific in the assistant's reply. Always exactly 4, numbered, nothing else.\n\nExample A\nDeveloper's message: the login form crashes when i submit empty fields\nAssistant's reply: Found it - the validator assumed a non-null email. I added a guard and a test; all 42 tests pass. Want me to also add guards to the signup form?\nSuggestions:\n1. Yes, guard the signup form too\n2. Not now, show me the diff first\n3. Which test covers the empty email case?\n4. Run the full suite once more\n\nExample B\nDeveloper's message: audit the checkout flow for accessibility problems\nAssistant's reply: The audit found 7 issues: 2 critical (missing labels on the card fields, focus trap in the coupon modal), 3 moderate contrast failures, and 2 minor ARIA gaps. The critical ones block screen-reader checkout entirely.\nSuggestions:\n1. Fix the two critical issues first\n2. Show me the coupon modal focus trap\n3. Which elements fail contrast?\n4. Give me the full issue list\n";

/// A title only needs the gist of the message — clamp the input so a big
/// paste never overflows the small model's context.
const TITLE_INPUT_CHARS: usize = 1500;

/// Titles are one short line; a tight generation cap keeps the call fast.
const TITLE_N_PREDICT: u32 = 48;

/// Longest title we accept from the model before hard-trimming (matches the
/// scale of the derived-title path in `agent_runtime::title`).
const TITLE_MAX_CHARS: usize = 60;
const TITLE_MAX_WORDS: usize = 8;

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
    run_completion(
        state,
        request_id,
        REFINE_SYSTEM,
        text,
        config,
        config.n_predict.clamp(16, 4096),
        None,
    )
}

/// Generate a chat title from the first user message with the SAME local
/// llama.cpp setup the refiner uses. Blocking — call from `spawn_blocking`.
/// Returns a cleaned, length-capped one-liner; any failure leaves the caller
/// on the locally-derived title.
pub fn generate_title_local(
    state: &RefineState,
    request_id: &str,
    text: &str,
    config: &RefineConfig,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to title".to_string());
    }
    // The gist is enough — clamp on a char boundary.
    let clamped: String = text.chars().take(TITLE_INPUT_CHARS).collect();

    let raw = run_completion(
        state,
        request_id,
        TITLE_SYSTEM,
        &clamped,
        config,
        TITLE_N_PREDICT,
        Some("0.3"),
    )?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return Err("model returned no usable title".to_string());
    }
    Ok(title)
}

/// Rewrite a voice-dictation transcript into clean written text with the same
/// local model. Returns the transcript's polished form; on any failure the
/// caller inserts the raw transcript unchanged.
pub fn clean_dictation(
    state: &RefineState,
    request_id: &str,
    text: &str,
    config: &RefineConfig,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to clean".to_string());
    }
    if text.chars().count() > MAX_INPUT_CHARS {
        return Err("transcript too long to clean".to_string());
    }
    let cleaned = run_completion(
        state,
        request_id,
        DICTATION_SYSTEM,
        text,
        config,
        1024,
        Some("0.2"),
    )?;
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Err("model returned no cleaned text".to_string());
    }
    // A cleanup that balloons or collapses the transcript changed the content,
    // not the punctuation — reject it and keep the user's own words.
    let in_len = text.chars().count();
    let out_len = cleaned.chars().count();
    if out_len * 3 < in_len || out_len > in_len * 2 + 80 {
        return Err("cleaned text diverged too far from the transcript".to_string());
    }
    Ok(cleaned.to_string())
}

/// How much of the assistant's message (as plain prose) feeds reply
/// suggestions. Generous on purpose — the model's 262k-native context makes
/// input length a non-issue, and the harness showed grounding quality comes
/// from seeing the WHOLE reply, not just its tail.
const SUGGEST_INPUT_CHARS: usize = 6000;

/// Flatten a markdown-formatted assistant reply into plain prose for the
/// suggestion model: tables, code blocks, headings, and emphasis markers are
/// dropped. Small models mimic whatever notation they're shown — feeding
/// tables back produced bolded pseudo-headings instead of replies.
fn plain_prose(text: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || trimmed.is_empty() || trimmed.contains('|') || trimmed.starts_with('#') {
            continue;
        }
        let cleaned: String = trimmed
            .trim_start_matches("- ")
            .trim_start_matches("* ")
            .chars()
            .filter(|c| !matches!(c, '*' | '`'))
            .collect();
        let cleaned = cleaned.trim();
        if !cleaned.is_empty() {
            out.push_str(cleaned);
            out.push(' ');
        }
    }
    out.trim().to_string()
}

/// How much of the user's own message feeds reply suggestions.
const SUGGEST_USER_INPUT_CHARS: usize = 600;

/// Longest suggestion list generation (4 short numbered lines).
const SUGGEST_N_PREDICT: u32 = 160;

/// Generate up to 4 tappable reply suggestions from the last exchange — ONE
/// model call that sees BOTH the user's message and the assistant's reply
/// and answers as the user. Output lines are individually filtered and
/// deduped, so the result may hold fewer entries (possibly zero).
pub fn suggest_replies(
    state: &RefineState,
    request_id: &str,
    user_text: &str,
    assistant_text: &str,
    config: &RefineConfig,
) -> Result<Vec<String>, String> {
    let assistant = plain_prose(assistant_text);
    if assistant.is_empty() {
        return Err("nothing to suggest from".to_string());
    }
    // The reply's tail carries the question/next-step context — keep the END.
    let chars: Vec<char> = assistant.chars().collect();
    let assistant_tail: String = chars[chars.len().saturating_sub(SUGGEST_INPUT_CHARS)..]
        .iter()
        .collect();
    let user = plain_prose(user_text);
    let user_head: String = user.chars().take(SUGGEST_USER_INPUT_CHARS).collect();

    // Labels match the few-shot examples in SUGGEST_SYSTEM exactly.
    let exchange = format!(
        "Developer's message:\n{user_head}\n\nAssistant's reply:\n{assistant_tail}\n\nSuggestions:"
    );
    let raw = run_completion(
        state,
        request_id,
        SUGGEST_SYSTEM,
        &exchange,
        config,
        SUGGEST_N_PREDICT,
        Some("0.7"),
    )?;

    let mut out: Vec<String> = Vec::with_capacity(4);
    for line in raw.lines() {
        let reply = sanitize_suggestion(line);
        if !acceptable_suggestion(&reply) {
            continue;
        }
        if out.iter().any(|prev| suggestions_overlap(prev, &reply)) {
            continue;
        }
        out.push(reply);
        if out.len() == 4 {
            break;
        }
    }
    Ok(out)
}

/// One llama-completion invocation with the given system prompt. Blocking.
/// `temperature` of `None` keeps llama.cpp's default sampling (the tuned
/// refine behavior); tasks needing determinism pass a low explicit value.
#[allow(clippy::too_many_arguments)]
fn run_completion(
    state: &RefineState,
    request_id: &str,
    system: &str,
    text: &str,
    config: &RefineConfig,
    n_predict: u32,
    temperature: Option<&str>,
) -> Result<String, String> {
    let exe = resolve_completion(&config.llama_dir)
        .ok_or_else(|| format!("{COMPLETION_EXE} not found in the configured folder"))?;
    if !Path::new(&config.model_path).is_file() {
        return Err("model .gguf not found".to_string());
    }

    let ngl = if config.device == "cpu" { "0" } else { "99" };
    let n_predict = n_predict.to_string();
    let prompt = build_chatml_prompt(system, text, &config.model_path);

    let mut command = Command::new(&exe);
    command
        .args([
            "-m",
            &config.model_path,
            "-no-cnv", // raw completion — see module docs for why NOT --jinja
            "-p",
            &prompt,
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
    if let Some(temp) = temperature {
        // Qwen-recommended nucleus settings ride along with any explicit
        // temperature (the smoke-tested combination); refine keeps llama.cpp
        // defaults by passing None.
        command.args(["--temp", temp, "--top-p", "0.8", "--top-k", "20"]);
    }

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

/// Trailing connector words that read broken when a word-cap cuts after them
/// ("Refactor payment service to use Stripe and" → drop the "and").
const TITLE_TRAILING_CONNECTORS: [&str; 12] = [
    "and", "or", "to", "for", "in", "on", "of", "the", "a", "an", "with", "vs",
];

/// Normalize a model-produced title: strip a leaked "Title:" label, keep the
/// first line only, drop sentence punctuation, cap words and characters, and
/// trim a dangling connector word. Small models occasionally ramble or echo
/// the few-shot label — everything past the first clean phrase is noise.
fn sanitize_title(raw: &str) -> String {
    let first_line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let unlabeled = first_line
        .trim_start()
        .strip_prefix("Title:")
        .or_else(|| first_line.trim_start().strip_prefix("title:"))
        .unwrap_or(first_line);
    // Titles need no sentence punctuation — dropping it wholesale also fixes
    // mid-title commas and "vs." artifacts. Hyphens and slashes stay.
    let depunctuated: String = unlabeled
        .chars()
        .filter(|c| !matches!(c, '.' | ',' | ':' | ';' | '!' | '?' | '"' | '\''))
        .collect();
    let mut words: Vec<&str> = depunctuated
        .split_whitespace()
        .take(TITLE_MAX_WORDS)
        .collect();
    while let Some(last) = words.last() {
        if TITLE_TRAILING_CONNECTORS.contains(&last.to_lowercase().as_str()) {
            words.pop();
        } else {
            break;
        }
    }
    let mut title = words.join(" ");
    if title.chars().count() > TITLE_MAX_CHARS {
        title = title.chars().take(TITLE_MAX_CHARS).collect::<String>();
        title = title.trim_end().to_string();
    }
    title
}

/// Normalize one model-produced reply suggestion: first line, no list prefix,
/// no wrapping quotes, no trailing sentence punctuation.
fn sanitize_suggestion(raw: &str) -> String {
    let first_line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut s = first_line.trim();
    // Strip a leading list marker ("1. ", "- ", "* ").
    if let Some(rest) = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| {
            s.split_once(". ")
                .filter(|(head, _)| head.chars().all(|c| c.is_ascii_digit()) && head.len() <= 2)
                .map(|(_, rest)| rest)
        })
    {
        s = rest;
    }
    s.trim()
        .trim_matches('"')
        .trim_end_matches(['.', '!', ';', ','])
        .trim()
        .to_string()
}

/// A usable suggestion is short, non-empty, and written in the USER's voice.
/// The rejected patterns are the failure modes observed in smoke tests
/// (assistant-voice offers and meta-narration). First-person "I'll…" replies
/// are LEGITIMATE here — the role-play prompt answers as the user.
fn acceptable_suggestion(s: &str) -> bool {
    let words = s.split_whitespace().count();
    if !(1..=12).contains(&words) {
        return false;
    }
    let lower = s.to_lowercase();
    ![
        "please provide",
        "great to hear",
        "sure, here",
        "here's ",
        "here is ",
    ]
    .iter()
    .any(|bad| lower.starts_with(bad))
}

/// Two suggestions overlap when most of their words match — the accept and
/// next-step roles often converge on the same sentence.
fn suggestions_overlap(a: &str, b: &str) -> bool {
    let set_a: std::collections::HashSet<String> = a
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let set_b: std::collections::HashSet<String> = b
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    if set_a.is_empty() || set_b.is_empty() {
        return true;
    }
    let shared = set_a.intersection(&set_b).count();
    shared * 10 >= set_a.len().min(set_b.len()) * 6
}

/// Format one system + user exchange in ChatML (the Qwen family template).
/// Qwen3-family models (3.5/3.6 hybrids) get an empty `<think></think>`
/// prefill on the assistant turn — the standard non-thinking switch, so a
/// one-shot title/cleanup never burns tokens on reasoning. ChatML control
/// markers are stripped from the user text so a hostile transcript can't
/// break out of its turn.
fn build_chatml_prompt(system: &str, text: &str, model_path: &str) -> String {
    let safe_text = text.replace("<|im_", "");
    let model = model_path.to_lowercase();
    let thinking_family = model.contains("qwen3") || model.contains("qwen-3");
    let mut prompt = format!(
        "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{safe_text}<|im_end|>\n<|im_start|>assistant\n"
    );
    if thinking_family {
        prompt.push_str("<think>\n\n</think>\n\n");
    }
    prompt
}

/// Strip the trailing `[end of text]` marker + surrounding whitespace, and drop
/// a wrapping pair of quotes if the model added them despite instructions.
/// Also removes a leading `<think>…</think>` block (a thinking model that
/// ignores the prefill) and a leaked trailing `<|im_end|>`.
fn clean_output(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(idx) = s.rfind(EOT_MARKER) {
        s = s[..idx].trim_end();
    }
    let mut s = s.trim();
    if let Some(rest) = s.strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            s = rest[end + "</think>".len()..].trim_start();
        }
    }
    if let Some(head) = s.strip_suffix("<|im_end|>") {
        s = head.trim_end();
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
