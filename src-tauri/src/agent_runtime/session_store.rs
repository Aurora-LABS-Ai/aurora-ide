//! Filesystem-backed store for [`Session`] files.
//!
//! This is the **single source of truth** for chat history persistence.
//! The legacy `ThreadEventLog` event-sourced store has
//! been retired — every Tauri thread command (`thread_list_summaries`,
//! `thread_load`, `thread_delete`, `thread_save`, `thread_update_usage`,
//! `thread_get_api_history`) now goes through this store.
//!
//! ## On-disk layout
//!
//! Inside [`SessionStore::dir`] (set up by `lib.rs::setup` to point at
//! `<app_data>/agent_v2/`) each thread owns two files:
//!
//! ```text
//! <thread_id>.jsonl       — one ConversationMessage per line
//! <thread_id>.meta.json   — {title, tokenUsage, contextUsage,
//!                            createdAt, updatedAt, workspaceRoot, model}
//! ```
//!
//! The `.jsonl` file is the canonical message history written by
//! [`Session::save_to_path`] / [`Session::append_to_path`]. The runtime
//! never had to know about the metadata sidecar — `TurnDriver` just
//! calls into this store after each turn to keep title/usage fresh.
//!
//! ## Why a sidecar?
//!
//! Three options were considered:
//! 1. Header line in the JSONL — breaks `Session::from_jsonl` parsing.
//! 2. Single-object JSON file — loses the append-only fast path the
//!    runtime relies on for incremental writes.
//! 3. Sidecar metadata — the chosen design. The `.jsonl` hot path is
//!    untouched, listing summaries reads only the small `.meta.json`
//!    files, and a missing sidecar is recoverable (we synthesise one
//!    on demand from the JSONL).
//!
//! ## Atomicity & races
//!
//! - JSONL writes go through `Session::save_to_path` (write-then-rename).
//! - Metadata writes use the same write-then-rename pattern.
//! - Concurrent readers/writers on the same thread are serialised by
//!   the `AgentRegistry` session lock (one `tokio::Mutex<Session>`
//!   per `thread_id`). `SessionStore` itself is therefore stateless
//!   and trivially `Sync`.

#![allow(dead_code)]

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::RuntimeError;
use super::session::Session;
use super::types::{ContentBlock, MessageRole};

// ============================================================================
// Metadata sidecar
// ============================================================================

/// Token accounting from the most recent provider response on this
/// thread. Mirrors `crate::db::TokenUsage` shape so frontend
/// consumers don't need a translation layer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageMeta {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u32>,
}

/// Aurora-side context window accounting (used + window + percentage).
/// Mirrors `crate::db::ContextUsage`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageMeta {
    #[serde(default)]
    pub used_tokens: u32,
    #[serde(default)]
    pub context_window: u32,
    #[serde(default)]
    pub percentage: f64,
}

/// Everything the chat list / thread loader needs that doesn't live
/// inside the `ConversationMessage` stream itself.
///
/// `created_at` / `updated_at` are RFC3339 strings so the frontend can
/// `Date.parse(...)` them without an extra Rust→JS millis conversion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub thread_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsageMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsageMeta>,
    pub created_at: String,
    pub updated_at: String,
}

impl SessionMetadata {
    /// Build a fresh metadata record for a brand-new thread.
    #[must_use]
    pub fn new(thread_id: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            thread_id: thread_id.into(),
            title: "New Chat".to_string(),
            workspace_root: None,
            model: None,
            token_usage: None,
            context_usage: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

// ============================================================================
// Listing summary — what the chat list (Thread History modal) consumes
// ============================================================================

/// Summary row served by [`SessionStore::list_summaries`]. Carries the
/// `messageCount` derived from the `.jsonl` plus a 120-char preview
/// pulled from the latest user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================================
// Store
// ============================================================================

/// Stateless wrapper around the agent_v2 sessions directory.
///
/// All methods are `&self` and re-resolve paths from `dir` on each
/// call so the store can be cloned cheaply (it's just a `PathBuf`).
#[derive(Debug, Clone)]
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    /// Build a store rooted at `dir`. The directory is created lazily
    /// on the first write — calling `new` on a non-existent directory
    /// is fine.
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Where the store lives on disk. Exposed for diagnostics and so
    /// the registry can hand the same directory to `Session::save_to_path`
    /// without having to reach inside the store.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path to the JSONL message log for `thread_id`.
    #[must_use]
    pub fn session_path(&self, thread_id: &str) -> PathBuf {
        self.dir.join(format!("{thread_id}.jsonl"))
    }

    /// Path to the metadata sidecar for `thread_id`.
    #[must_use]
    pub fn meta_path(&self, thread_id: &str) -> PathBuf {
        self.dir.join(format!("{thread_id}.meta.json"))
    }

    /// `true` iff at least the message log exists. The metadata
    /// sidecar may be missing on threads created before this store
    /// shipped — they're transparently upgraded on the first read.
    #[must_use]
    pub fn exists(&self, thread_id: &str) -> bool {
        self.session_path(thread_id).exists()
    }

    // ----------------------------------------------------------------
    // List
    // ----------------------------------------------------------------

    /// Walk the store directory and build a [`SessionSummary`] for
    /// every thread found. Sessions are returned sorted by
    /// `updated_at` descending (newest first) — same order the chat
    /// list expects.
    ///
    /// Threads with a missing or unreadable sidecar are still
    /// included with synthesised metadata (title = "New Chat", times
    /// from the JSONL's filesystem mtime) so a corrupted sidecar
    /// can't make a thread invisible.
    pub fn list_summaries(&self) -> Result<Vec<SessionSummary>, RuntimeError> {
        let mut out = Vec::new();
        let read = match fs::read_dir(&self.dir) {
            Ok(r) => r,
            // Fresh install — store dir doesn't exist yet. Empty list,
            // not an error.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(RuntimeError::from(e)),
        };

        for entry in read.flatten() {
            let path = entry.path();
            // Only `<thread_id>.jsonl` files are session logs. Skip
            // sidecars, tmp files, stray directories.
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // `<id>.jsonl.tmp` would land here as stem `<id>.jsonl` —
            // skip anything that still ends in `.jsonl`.
            if stem.ends_with(".jsonl") {
                continue;
            }

            match self.summarize_thread(&stem, &path) {
                Ok(summary) => out.push(summary),
                Err(err) => {
                    eprintln!(
                        "[SessionStore] failed to summarize {stem}: {err}; skipping"
                    );
                }
            }
        }

        // Sort newest-first by RFC3339 string compare — works because
        // RFC3339 is lexicographically ordered.
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    /// Build one [`SessionSummary`] for `thread_id`. Reads the
    /// sidecar for title/timestamps and the JSONL for messageCount +
    /// preview. Missing sidecar → synthesised defaults.
    fn summarize_thread(
        &self,
        thread_id: &str,
        jsonl_path: &Path,
    ) -> Result<SessionSummary, RuntimeError> {
        let meta = self
            .load_metadata(thread_id)
            .unwrap_or_else(|_| SessionMetadata::new(thread_id));

        // Stream the JSONL just enough to count messages and pull the
        // last user message as preview. A full Session::load_from_path
        // would deserialize every block — overkill for the chat list.
        let session = Session::load_from_path(thread_id.to_string(), jsonl_path).ok();
        let (message_count, preview) = match session {
            Some(s) => {
                let count = s.messages().len();
                let preview = s
                    .messages()
                    .iter()
                    .rev()
                    .find(|m| matches!(m.role, MessageRole::User))
                    .map(|m| collect_text_preview(&m.blocks, 120))
                    .unwrap_or_default();
                (count, preview)
            }
            None => (0, String::new()),
        };

        Ok(SessionSummary {
            id: thread_id.to_string(),
            title: meta.title,
            message_count,
            preview,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
        })
    }

    // ----------------------------------------------------------------
    // Load
    // ----------------------------------------------------------------

    /// Load both the message stream and metadata for `thread_id`.
    /// Returns `Ok(None)` when the thread doesn't exist.
    pub fn load(&self, thread_id: &str) -> Result<Option<LoadedSession>, RuntimeError> {
        let jsonl_path = self.session_path(thread_id);
        if !jsonl_path.exists() {
            return Ok(None);
        }
        let session = Session::load_from_path(thread_id.to_string(), &jsonl_path)?;
        let metadata = self
            .load_metadata(thread_id)
            .unwrap_or_else(|_| SessionMetadata::new(thread_id));
        Ok(Some(LoadedSession { session, metadata }))
    }

    /// Load just the metadata. Synthesises a fresh record if the
    /// sidecar is missing or malformed.
    pub fn load_metadata(&self, thread_id: &str) -> Result<SessionMetadata, RuntimeError> {
        let path = self.meta_path(thread_id);
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(SessionMetadata::new(thread_id));
            }
            Err(e) => return Err(RuntimeError::from(e)),
        };
        let meta: SessionMetadata = serde_json::from_str(&raw).map_err(|e| {
            RuntimeError::InvalidState(format!(
                "{} is malformed: {e}",
                path.display()
            ))
        })?;
        Ok(meta)
    }

    // ----------------------------------------------------------------
    // Mutate
    // ----------------------------------------------------------------

    /// Idempotent: ensure both files exist for `thread_id`. Used by
    /// `thread_save` / `thread_create` to materialise an empty
    /// thread before any messages are appended.
    ///
    /// Returns the resulting metadata so callers can read back the
    /// canonical timestamps (the sidecar's `created_at` may be older
    /// than "now" if the thread already existed).
    pub fn ensure_thread(
        &self,
        thread_id: &str,
        title: Option<String>,
    ) -> Result<SessionMetadata, RuntimeError> {
        fs::create_dir_all(&self.dir)?;

        // Touch the JSONL so listings pick the thread up even before
        // any messages land.
        let jsonl_path = self.session_path(thread_id);
        if !jsonl_path.exists() {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&jsonl_path)?;
        }

        let mut meta = self.load_metadata(thread_id)?;
        let was_default = meta.title == "New Chat";
        if let Some(t) = title {
            if !t.is_empty() && (was_default || meta.title != t) {
                meta.title = t;
                meta.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }
        // First-time creation: persist the bootstrap metadata.
        if !self.meta_path(thread_id).exists() {
            self.save_metadata(&meta)?;
        }
        Ok(meta)
    }

    /// Update the title in the metadata sidecar. No-op when the title
    /// hasn't changed.
    pub fn set_title(
        &self,
        thread_id: &str,
        title: String,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        if meta.title == title {
            return Ok(meta);
        }
        meta.title = title;
        meta.updated_at = chrono::Utc::now().to_rfc3339();
        self.save_metadata(&meta)?;
        Ok(meta)
    }

    /// Update token + context usage on the sidecar. Each call also
    /// bumps `updated_at` so the chat list re-orders this thread to
    /// the top.
    pub fn set_usage(
        &self,
        thread_id: &str,
        token_usage: Option<TokenUsageMeta>,
        context_usage: Option<ContextUsageMeta>,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        if let Some(tu) = token_usage {
            meta.token_usage = Some(tu);
        }
        if let Some(cu) = context_usage {
            meta.context_usage = Some(cu);
        }
        meta.updated_at = chrono::Utc::now().to_rfc3339();
        self.save_metadata(&meta)?;
        Ok(meta)
    }

    /// Update workspace_root + model on the sidecar without touching
    /// usage. Called by `TurnDriver` once per turn so the modal can
    /// show which model was last used on a thread.
    pub fn set_workspace_and_model(
        &self,
        thread_id: &str,
        workspace_root: Option<String>,
        model: Option<String>,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        let mut dirty = false;
        if let Some(ws) = workspace_root {
            if meta.workspace_root.as_deref() != Some(ws.as_str()) {
                meta.workspace_root = Some(ws);
                dirty = true;
            }
        }
        if let Some(m) = model {
            if meta.model.is_none() {
                meta.model = Some(m);
                dirty = true;
            }
        }
        if dirty {
            meta.updated_at = chrono::Utc::now().to_rfc3339();
            self.save_metadata(&meta)?;
        }
        Ok(meta)
    }

    /// Bump just the updated_at field. Called by `TurnDriver` after
    /// every successful turn so the chat list reflects activity even
    /// when the title and usage didn't change.
    pub fn touch(&self, thread_id: &str) -> Result<(), RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        meta.updated_at = chrono::Utc::now().to_rfc3339();
        self.save_metadata(&meta)?;
        Ok(())
    }

    /// Atomically replace the metadata sidecar. The actual JSONL is
    /// owned by `Session::save_to_path` / `Session::append_to_path`.
    fn save_metadata(&self, meta: &SessionMetadata) -> Result<(), RuntimeError> {
        fs::create_dir_all(&self.dir)?;
        let path = self.meta_path(&meta.thread_id);
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(meta)?;
        {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Remove both the JSONL and metadata sidecar. Idempotent — a
    /// missing file is treated as success.
    pub fn delete(&self, thread_id: &str) -> Result<(), RuntimeError> {
        for path in [self.session_path(thread_id), self.meta_path(thread_id)] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(RuntimeError::from(e)),
            }
        }
        Ok(())
    }
}

/// Bundle returned by [`SessionStore::load`].
#[derive(Debug)]
pub struct LoadedSession {
    pub session: Session,
    pub metadata: SessionMetadata,
}

/// Concatenate the `Text` blocks of a message and clamp to `limit`
/// chars. Used to build the chat-list preview from the most recent
/// user message.
fn collect_text_preview(blocks: &[ContentBlock], limit: usize) -> String {
    let mut out = String::new();
    for block in blocks {
        if let ContentBlock::Text { text } = block {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(text);
            if out.chars().count() >= limit {
                break;
            }
        }
    }
    out.chars().take(limit).collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::ConversationMessage;

    fn tmp_store() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn ensure_thread_creates_files_and_default_metadata() {
        let (_g, store) = tmp_store();
        let meta = store.ensure_thread("t1", None).expect("ensure");
        assert_eq!(meta.thread_id, "t1");
        assert_eq!(meta.title, "New Chat");
        assert!(store.session_path("t1").exists());
        assert!(store.meta_path("t1").exists());
    }

    #[test]
    fn list_summaries_returns_threads_sorted_newest_first() {
        let (_g, store) = tmp_store();
        store.ensure_thread("a", Some("First".into())).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.ensure_thread("b", Some("Second".into())).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.touch("a").unwrap();

        let summaries = store.list_summaries().unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "a", "touched thread sorts to top");
    }

    #[test]
    fn message_count_and_preview_come_from_jsonl() {
        let (_g, store) = tmp_store();
        store.ensure_thread("p", Some("Title".into())).unwrap();

        let mut session = Session::new("p");
        session.append_message(ConversationMessage::user_text(
            "hello there",
            chrono::Utc::now().timestamp_millis(),
        ));
        session.append_message(ConversationMessage::assistant(
            vec![ContentBlock::Text {
                text: "hi".to_string(),
            }],
            chrono::Utc::now().timestamp_millis(),
        ));
        session.save_to_path(store.session_path("p")).unwrap();

        let summaries = store.list_summaries().unwrap();
        let entry = summaries.iter().find(|s| s.id == "p").expect("entry");
        assert_eq!(entry.message_count, 2);
        assert_eq!(entry.preview, "hello there");
        assert_eq!(entry.title, "Title");
    }

    #[test]
    fn set_title_updates_metadata_and_bumps_updated_at() {
        let (_g, store) = tmp_store();
        let m1 = store.ensure_thread("x", None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let m2 = store.set_title("x", "Renamed".into()).unwrap();
        assert_eq!(m2.title, "Renamed");
        assert!(
            m2.updated_at >= m1.updated_at,
            "updated_at must move forward"
        );
    }

    #[test]
    fn set_usage_persists_token_and_context_metadata() {
        let (_g, store) = tmp_store();
        store.ensure_thread("u", None).unwrap();
        let token = TokenUsageMeta {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            ..Default::default()
        };
        let ctx = ContextUsageMeta {
            used_tokens: 100,
            context_window: 1000,
            percentage: 10.0,
        };
        store
            .set_usage("u", Some(token.clone()), Some(ctx.clone()))
            .unwrap();
        let meta = store.load_metadata("u").unwrap();
        assert_eq!(meta.token_usage.as_ref().unwrap().prompt_tokens, 10);
        assert_eq!(meta.context_usage.as_ref().unwrap().used_tokens, 100);
    }

    #[test]
    fn delete_removes_jsonl_and_meta() {
        let (_g, store) = tmp_store();
        store.ensure_thread("d", None).unwrap();
        assert!(store.session_path("d").exists());
        assert!(store.meta_path("d").exists());
        store.delete("d").unwrap();
        assert!(!store.session_path("d").exists());
        assert!(!store.meta_path("d").exists());
    }

    #[test]
    fn delete_is_idempotent() {
        let (_g, store) = tmp_store();
        store.delete("nonexistent").expect("idempotent delete");
    }

    #[test]
    fn missing_metadata_sidecar_synthesizes_defaults() {
        let (_g, store) = tmp_store();
        // Drop just the JSONL, no sidecar.
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(store.session_path("orphan"), "").unwrap();
        let meta = store.load_metadata("orphan").unwrap();
        assert_eq!(meta.title, "New Chat");
        assert_eq!(meta.thread_id, "orphan");
    }

    #[test]
    fn list_summaries_skips_jsonl_tmp_artifacts() {
        let (_g, store) = tmp_store();
        store.ensure_thread("real", None).unwrap();
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(
            store.dir().join("real.jsonl.tmp"),
            "stale-rename-leftover",
        )
        .unwrap();
        let summaries = store.list_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "real");
    }
}
