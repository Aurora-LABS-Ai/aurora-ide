//! Filesystem layout for the Aurora agent.
//!
//! Everything the agent persists lives under a single root:
#![allow(dead_code)]
//
// `settings_path()` / `SETTINGS_FILE` are reserved for the agent settings
// event log we ship in the next milestone. Suppress the warning until that
// command lands.
//!
//! ```text
//! <config_dir>/Aurora-Agent-IDE/Agent/
//! ├── Threads/
//! │   ├── <uuid-1>.jsonl        ← one append-only file per thread
//! │   └── <uuid-2>.jsonl
//! ├── threads-index.jsonl       ← append-only thread summary index
//! └── settings.jsonl            ← append-only agent-level settings
//! ```
//!
//! The root resolves to:
//! - **Windows:** `%APPDATA%\Aurora-Agent-IDE\Agent\`
//! - **macOS:** `~/Library/Application Support/Aurora-Agent-IDE/Agent/`
//! - **Linux:** `~/.config/Aurora-Agent-IDE/Agent/`
//!
//! For tests and isolated harnesses, set the `AURORA_AGENT_DIR` environment
//! variable to override the root with an absolute path.

use std::path::{Path, PathBuf};

/// Display name used as the top-level folder under `<config_dir>`.
const APP_DIR_NAME: &str = "Aurora-Agent-IDE";

/// Subfolder containing all agent state.
const AGENT_SUBDIR: &str = "Agent";

/// Subfolder containing per-thread `.jsonl` files.
const THREADS_SUBDIR: &str = "Threads";

/// Filename of the thread index.
const THREADS_INDEX_FILE: &str = "threads-index.jsonl";

/// Filename of the agent settings event log.
const SETTINGS_FILE: &str = "settings.jsonl";

/// Environment variable used to override the agent root (tests, sandboxes).
pub const AGENT_DIR_OVERRIDE_ENV: &str = "AURORA_AGENT_DIR";

// ============================================================================
// PATHS
// ============================================================================

/// Errors that can occur while resolving or creating agent paths.
#[derive(Debug, thiserror::Error)]
pub enum PathError {
    /// Could not determine the platform's config directory and no override was
    /// provided. This typically means a misconfigured environment (e.g. no
    /// `HOME` set on Linux).
    #[error("could not resolve user config directory")]
    NoConfigDir,

    /// `AURORA_AGENT_DIR` was set but pointed at a non-absolute path.
    #[error("AURORA_AGENT_DIR must be an absolute path, got: {0}")]
    OverrideNotAbsolute(PathBuf),

    /// Thread id contained characters that would escape the threads dir
    /// (path separators, `..`, NUL byte, etc.). Defense in depth — UUIDs
    /// don't trigger this.
    #[error("thread id contains illegal characters: {0:?}")]
    UnsafeThreadId(String),

    /// A filesystem operation (mkdir, etc.) failed.
    #[error("filesystem error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl PathError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type PathResult<T> = Result<T, PathError>;

// ----------------------------------------------------------------------------
// Resolution
// ----------------------------------------------------------------------------

/// Returns the agent root directory without touching the filesystem.
///
/// Resolution order:
/// 1. `AURORA_AGENT_DIR` env var if set (must be absolute).
/// 2. `<config_dir>/Aurora-Agent-IDE/Agent/`.
pub fn agent_root() -> PathResult<PathBuf> {
    if let Some(override_dir) = read_override_env() {
        let p = PathBuf::from(override_dir);
        if !p.is_absolute() {
            return Err(PathError::OverrideNotAbsolute(p));
        }
        return Ok(p);
    }

    let base = dirs::config_dir().ok_or(PathError::NoConfigDir)?;
    Ok(base.join(APP_DIR_NAME).join(AGENT_SUBDIR))
}

/// Returns the directory holding per-thread `.jsonl` files.
pub fn threads_dir() -> PathResult<PathBuf> {
    Ok(agent_root()?.join(THREADS_SUBDIR))
}

/// Path to the append-only thread summary index.
pub fn threads_index_path() -> PathResult<PathBuf> {
    Ok(agent_root()?.join(THREADS_INDEX_FILE))
}

/// Path to the append-only agent settings log.
pub fn settings_path() -> PathResult<PathBuf> {
    Ok(agent_root()?.join(SETTINGS_FILE))
}

/// Path to the JSONL file for a specific thread.
///
/// Validates `thread_id` to prevent path traversal even though the rest of the
/// codebase only feeds UUIDs through this function.
pub fn thread_file(thread_id: &str) -> PathResult<PathBuf> {
    validate_thread_id(thread_id)?;
    let mut p = threads_dir()?;
    p.push(format!("{thread_id}.jsonl"));
    Ok(p)
}

// ----------------------------------------------------------------------------
// Mutating helpers — create directories on demand
// ----------------------------------------------------------------------------

/// Ensures the agent root and the threads dir exist on disk. Returns the
/// agent root.
pub fn ensure_agent_root() -> PathResult<PathBuf> {
    let root = agent_root()?;
    create_dir_all(&root)?;
    create_dir_all(&root.join(THREADS_SUBDIR))?;
    Ok(root)
}

/// Ensures `Threads/` exists and returns its path.
pub fn ensure_threads_dir() -> PathResult<PathBuf> {
    let dir = threads_dir()?;
    create_dir_all(&dir)?;
    Ok(dir)
}

/// Ensures the parent directory for a thread file exists; returns the file
/// path itself (the file is *not* created here).
pub fn ensure_thread_file_parent(thread_id: &str) -> PathResult<PathBuf> {
    ensure_threads_dir()?;
    thread_file(thread_id)
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

fn read_override_env() -> Option<String> {
    match std::env::var(AGENT_DIR_OVERRIDE_ENV) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

fn create_dir_all(path: &Path) -> PathResult<()> {
    std::fs::create_dir_all(path).map_err(|e| PathError::io(path.to_path_buf(), e))
}

/// Rejects any thread id that would let a caller escape the threads directory
/// (path separators, parent-dir refs, NUL bytes, leading dots).
fn validate_thread_id(thread_id: &str) -> PathResult<()> {
    if thread_id.is_empty()
        || thread_id.len() > 128
        || thread_id.starts_with('.')
        || thread_id
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || thread_id.contains("..")
    {
        return Err(PathError::UnsafeThreadId(thread_id.to_string()));
    }
    Ok(())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Lock around env var manipulation so concurrent test threads don't trash
    /// each other's `AURORA_AGENT_DIR` value.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_override<R>(dir: &Path, f: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().unwrap();
        let prior = std::env::var(AGENT_DIR_OVERRIDE_ENV).ok();
        // SAFETY: tests are serialized via ENV_LOCK above.
        std::env::set_var(AGENT_DIR_OVERRIDE_ENV, dir);
        let result = f();
        match prior {
            Some(v) => std::env::set_var(AGENT_DIR_OVERRIDE_ENV, v),
            None => std::env::remove_var(AGENT_DIR_OVERRIDE_ENV),
        }
        result
    }

    #[test]
    fn override_env_is_honored() {
        let tmp = tempfile::tempdir().unwrap();
        with_override(tmp.path(), || {
            assert_eq!(agent_root().unwrap(), tmp.path());
            assert_eq!(threads_dir().unwrap(), tmp.path().join(THREADS_SUBDIR));
            assert_eq!(
                threads_index_path().unwrap(),
                tmp.path().join(THREADS_INDEX_FILE)
            );
            assert_eq!(settings_path().unwrap(), tmp.path().join(SETTINGS_FILE));
        });
    }

    #[test]
    fn override_must_be_absolute() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(AGENT_DIR_OVERRIDE_ENV, "relative/path");
        let err = agent_root().unwrap_err();
        std::env::remove_var(AGENT_DIR_OVERRIDE_ENV);
        assert!(matches!(err, PathError::OverrideNotAbsolute(_)));
    }

    #[test]
    fn ensure_agent_root_creates_threads_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("nested").join("agent");
        with_override(&target, || {
            ensure_agent_root().unwrap();
            assert!(target.is_dir());
            assert!(target.join(THREADS_SUBDIR).is_dir());
        });
    }

    #[test]
    fn thread_file_is_under_threads_dir() {
        let tmp = tempfile::tempdir().unwrap();
        with_override(tmp.path(), || {
            let p = thread_file("11111111-1111-1111-1111-111111111111").unwrap();
            assert_eq!(p.parent().unwrap(), &tmp.path().join(THREADS_SUBDIR));
            assert!(p.file_name().unwrap().to_string_lossy().ends_with(".jsonl"));
        });
    }

    #[test]
    fn rejects_path_traversal_in_thread_id() {
        let cases = [
            "../escape",
            "..",
            "/abs/path",
            "back\\slash",
            "with:colon",
            "null\0byte",
            "",
            ".hidden",
        ];
        let tmp = tempfile::tempdir().unwrap();
        with_override(tmp.path(), || {
            for bad in cases {
                let err = thread_file(bad).unwrap_err();
                assert!(
                    matches!(err, PathError::UnsafeThreadId(_)),
                    "{bad:?} should be rejected"
                );
            }
        });
    }
}
