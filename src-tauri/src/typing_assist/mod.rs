//! Statistical typing-assistance for the Agent Window composer.
//!
//! A native, fully-local engine that mirrors the "TypeAssist" experience:
//! autocorrect on word boundaries, inline word completion, and next-word
//! prediction — all driven by bundled open-source frequency data (SymSpell's
//! English unigram + bigram dictionaries) plus a personal, on-disk lexicon that
//! learns the words you actually type.
//!
//! The heavy state (a ~82k-word trie + ~242k bigrams) lives here in Rust, built
//! once and shared behind an `Arc`. The frontend composer stays thin: it calls
//! the `typing_assist_*` commands (debounced) and renders ghost text.
//!
//! Data flow on first activation:
//!   bundled resources ──copy──▶ %LOCALAPPDATA%/AuroraIDE/typing-assist/*.txt
//!                                        │
//!                                        ▼  (build off-thread, ~200ms)
//!                                    Engine (trie + bigram + lexicon)

mod common_misspellings;
mod engine;
mod lexicon;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use engine::Engine;
pub use engine::{Ghost, GhostKind};

const FREQ_FILE: &str = "frequency_dictionary_en.txt";
const BIGRAM_FILE: &str = "frequency_bigramdictionary_en.txt";
const LEXICON_FILE: &str = "lexicon.json";

/// Shared, lazily-initialized engine state managed by Tauri.
#[derive(Default)]
pub struct TypingAssistState {
    engine: Mutex<Option<Arc<Engine>>>,
}

impl TypingAssistState {
    /// The loaded engine, if ready.
    pub fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.lock().clone()
    }

    pub fn is_ready(&self) -> bool {
        self.engine.lock().is_some()
    }
}

/// Copy the bundled dictionaries into the app-data typing-assist dir (once) and
/// build the engine. Blocking — run under `spawn_blocking`. Idempotent: if the
/// engine is already loaded this is a cheap no-op.
pub fn ensure_loaded(state: &TypingAssistState, resource_dir: &Path) -> Result<(), String> {
    if state.is_ready() {
        return Ok(());
    }

    let data_dir = crate::paths::typing_assist_dir();
    let freq = ensure_copied(resource_dir, &data_dir, FREQ_FILE)?;
    let bigram = ensure_copied(resource_dir, &data_dir, BIGRAM_FILE)?;
    let lexicon_path = data_dir.join(LEXICON_FILE);

    let engine = Engine::load(&freq, &bigram, lexicon_path)
        .map_err(|e| format!("failed to build typing-assist index: {e}"))?;

    *state.engine.lock() = Some(Arc::new(engine));
    Ok(())
}

/// Ensure `<data_dir>/<name>` exists, copying from the bundled resource dir on
/// first run. Returns the app-data path to load from.
fn ensure_copied(resource_dir: &Path, data_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let dest = data_dir.join(name);
    if dest.is_file() {
        return Ok(dest);
    }
    let src = resolve_resource(resource_dir, name)
        .ok_or_else(|| format!("bundled dictionary '{name}' not found"))?;
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create {data_dir:?}: {e}"))?;
    std::fs::copy(&src, &dest).map_err(|e| format!("copy {name}: {e}"))?;
    Ok(dest)
}

/// Find a bundled dictionary across the layouts Tauri uses in dev vs. release.
fn resolve_resource(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let candidates = [
        resource_dir.join("typing-assist").join(name),
        resource_dir
            .join("resources")
            .join("typing-assist")
            .join(name),
        // Dev fallback: run straight from the crate's `resources/` folder.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("typing-assist")
            .join(name),
    ];
    candidates.into_iter().find(|p| p.is_file())
}
