//! Single source of truth for every filesystem location Aurora owns.
//!
//! Everything the IDE persists at runtime — SQLite DB, checkpoint git
//! shadows, agent session JSONLs, MCP config, semantic cache, logs —
//! lives under one root:
//!
//!   Windows: %LOCALAPPDATA%\AuroraIDE\
//!   macOS:   ~/Library/Application Support/AuroraIDE/
//!   Linux:   ~/.local/share/AuroraIDE/
//!
//! Subfolders are created lazily by the accessor that needs them, so a
//! brand-new install lands with only the dirs it actually touches.
//!
//! There is no migration from older locations on purpose — this is the
//! pre-1.0 single-developer phase. Once shipped to users, the layout
//! is frozen.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Root folder name under the platform's local-app-data root.
const ROOT_NAME: &str = "AuroraIDE";

/// Cache the resolved root so we only log it once per process and so
/// repeated lookups don't hit `dirs::*` over and over.
static RESOLVED_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the single AuroraIDE root, creating it if missing.
///
/// Hard-errors when the OS doesn't expose any of local-app-data /
/// data / home — silently dropping the DB into CWD would lead to
/// per-run state loss the user would only discover after losing a
/// session, which is far worse than a clear startup panic.
pub fn root() -> PathBuf {
    if let Some(cached) = RESOLVED_ROOT.get() {
        return cached.clone();
    }
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| {
            panic!(
                "AuroraIDE: cannot resolve a writable application directory \
                 (data_local_dir / data_dir / home_dir all returned None). \
                 The IDE refuses to fall back to the current working directory \
                 because that would lose all persisted state on every relaunch."
            )
        });
    let root = base.join(ROOT_NAME);
    ensure(&root);
    eprintln!("[paths] AuroraIDE root resolved to {}", root.display());
    let _ = RESOLVED_ROOT.set(root.clone());
    root
}

/// `<root>/data/` — SQLite database + WAL/SHM sidecars.
pub fn data_dir() -> PathBuf {
    ensure_subdir("data")
}

/// `<root>/data/aurora.db`.
pub fn db_file() -> PathBuf {
    data_dir().join("aurora.db")
}

/// `<root>/checkpoints/` — git shadow repos, one per workspace hash.
pub fn checkpoints_dir() -> PathBuf {
    ensure_subdir("checkpoints")
}

/// `<root>/sessions/` — agent_v2 session JSONL + meta sidecars.
pub fn sessions_dir() -> PathBuf {
    ensure_subdir("sessions")
}

/// `<root>/config/` — user-facing JSON config files (e.g. mcp.json).
pub fn config_dir() -> PathBuf {
    ensure_subdir("config")
}

/// `<root>/config/mcp.json`.
pub fn mcp_config_file() -> PathBuf {
    config_dir().join("mcp.json")
}

/// `<root>/cache/` — derived/regeneratable data (semantic indexes, etc).
#[allow(dead_code)]
pub fn cache_dir() -> PathBuf {
    ensure_subdir("cache")
}

/// `<root>/logs/` — reserved for future file-based logging.
#[allow(dead_code)]
pub fn logs_dir() -> PathBuf {
    ensure_subdir("logs")
}

fn ensure_subdir(name: &str) -> PathBuf {
    let dir = root().join(name);
    ensure(&dir);
    dir
}

fn ensure(p: &Path) {
    let _ = std::fs::create_dir_all(p);
}
