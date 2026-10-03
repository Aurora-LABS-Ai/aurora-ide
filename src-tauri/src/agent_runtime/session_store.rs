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
//! Build stores live in `<root>/projects/<workspace-slug>/`; Chat lives in
//! `<root>/Chats/`. Each conversation owns a folder inside its store:
//!
//! ```text
//! <thread_id>/conversation.jsonl — one ConversationMessage per line
//! <thread_id>/meta.json          — title, usage, workspace, model, timestamps
//! <thread_id>/rich.jsonl         — full tool results
//! <thread_id>/artifacts.json     — saved canvases
//! <thread_id>/todos.json         — Build checklist
//! <thread_id>/tool-results/      — spilled tool output
//! threads.db                    — disposable listing cache
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

use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::RuntimeError;
use super::session::{RichToolResult, Session};
use super::session_index::{self, Fingerprint, SessionIndex};
use super::types::{ContentBlock, ConversationMessage, MessageRole};

#[cfg(test)]
thread_local! {
    static SUMMARIZED_THREADS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

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
    /// `Some(true)` when these counts are a local tiktoken estimate rather than
    /// provider-reported usage. Round-tripped so the `~` flag survives reopen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
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
    /// Whether the user has pinned this chat to the top of the rail.
    /// Defaults to `false` for threads created before pinning shipped.
    #[serde(default)]
    pub pinned: bool,
    /// RFC3339 instant the chat was archived, or `None` when active. Doubles
    /// as the retention clock: an archive older than 15 days is purged on the
    /// next listing (see [`SessionStore::list_summaries_filtered`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// Aurora Chat: was this conversation started in deep research?
    ///
    /// **Set once, at creation, and never changed.** Deep research is how a
    /// conversation was framed rather than a switch you flip mid-way — and the
    /// prompt section it injects rides in the cacheable prefix, so flipping it
    /// would throw the conversation's whole cache away as well.
    ///
    /// `#[serde(default)]` so every conversation written before this shipped
    /// reads as a normal chat rather than failing to load.
    #[serde(default)]
    pub deep_research: bool,
    /// The lead conversation this one is a team member of.
    ///
    /// A team member is an ordinary conversation — same engine, same files —
    /// that the lead conversation created. The mark keeps it out of the chat
    /// list (its tab lives beside the lead), and deleting the lead deletes it.
    /// Set once, at creation. `None` for every conversation a person started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_member_of: Option<String>,
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
            pinned: false,
            archived_at: None,
            deep_research: false,
            team_member_of: None,
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
    /// The project this thread belongs to (its `workspace_root`).
    /// `None` for threads created before scoping shipped — those are
    /// "ungrouped" and excluded from any project-filtered listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// The model this conversation is on, as `"providerId:modelKey"`.
    /// `None` for threads that have never run a turn and were never
    /// explicitly pinned — those fall back to the user's default model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Pinned chats sort above the rest of the list in the rail.
    #[serde(default)]
    pub pinned: bool,
    /// RFC3339 instant the chat was archived, or `None` when active. The rail
    /// routes archived chats into the "Archived" view instead of the tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// Aurora Chat: the conversation was started in deep research. Fixed at
    /// creation — see [`SessionMetadata::deep_research`].
    #[serde(default)]
    pub deep_research: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// One conversation the directory walk found, and the stamps that decide
/// whether its cached summary can be reused.
struct FoundThread {
    id: String,
    log: PathBuf,
    fingerprint: Fingerprint,
}

/// How long an archived chat is retained before it is permanently purged.
/// Measured from the chat's `archived_at` instant.
const ARCHIVE_RETENTION_DAYS: i64 = 15;

/// `true` iff `archived_at` (RFC3339) is older than [`ARCHIVE_RETENTION_DAYS`].
/// An unparseable timestamp is treated as NOT expired so a malformed sidecar
/// can never trigger silent data loss.
fn archive_expired(archived_at: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(archived_at) {
        Ok(ts) => {
            let age = chrono::Utc::now().signed_duration_since(ts.with_timezone(&chrono::Utc));
            age.num_days() >= ARCHIVE_RETENTION_DAYS
        }
        Err(_) => false,
    }
}

// ============================================================================
// Store
// ============================================================================

/// How a store arranges one conversation's files on disk.
///
/// Both products use a folder per conversation. Flat storage remains available
/// for isolated fixtures and readers of the former layout.
///
/// Everything above the five path methods, the listing scan and `delete` is
/// shared: journaling, metadata, archiving, retention, artifacts and loading
/// all work the same either way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StoreLayout {
    /// `<dir>/<id>.jsonl` plus `<id>.meta.json`, `<id>.rich.jsonl`, and the
    /// rest beside it, identified by filename stem.
    #[default]
    Flat,
    /// `<dir>/<id>/conversation.jsonl` plus fixed filenames in that folder.
    /// Used by project stores and Aurora Chat (`paths::chats_dir()`).
    Folder,
}

/// Stateless wrapper around a conversation store directory.
///
/// All methods are `&self` and re-resolve paths from `dir` on each
/// call so the store can be cloned cheaply (it's just a `PathBuf`).
#[derive(Debug, Clone)]
pub struct SessionStore {
    dir: PathBuf,
    layout: StoreLayout,
    owns_assets: bool,
    usage_ledger: Option<std::sync::Arc<crate::usage_ledger::UsageLedger>>,
}

impl SessionStore {
    /// Build a flat store rooted at `dir`, for legacy readers and fixtures.
    /// The directory is created lazily on the first write, so calling `new` on
    /// a non-existent directory is fine.
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            layout: StoreLayout::Flat,
            owns_assets: false,
            usage_ledger: None,
        }
    }

    /// Build a folder-per-conversation store rooted at `dir` — Aurora Chat's
    /// `Chats/` layout.
    #[must_use]
    pub fn new_folder(dir: PathBuf) -> Self {
        Self {
            dir,
            layout: StoreLayout::Folder,
            owns_assets: true,
            usage_ledger: None,
        }
    }

    /// Build conversations share a project root but own no image assets.
    #[must_use]
    pub fn new_project(dir: PathBuf) -> Self {
        Self {
            dir,
            layout: StoreLayout::Folder,
            owns_assets: false,
            usage_ledger: None,
        }
    }

    pub fn with_usage_ledger(
        mut self,
        ledger: Option<std::sync::Arc<crate::usage_ledger::UsageLedger>>,
    ) -> Self {
        self.usage_ledger = ledger;
        self
    }

    pub fn preserve_usage(&self, thread_id: &str) -> Result<(), RuntimeError> {
        if let Some(ledger) = &self.usage_ledger {
            ledger
                .preserve_source(
                    self.session_path(thread_id),
                    self.meta_path(thread_id),
                    thread_id,
                    if self.owns_assets { "chat" } else { "build" },
                )
                .map_err(|error| {
                    RuntimeError::InvalidState(format!(
                        "could not preserve usage for {thread_id}: {error:#}"
                    ))
                })?;
        }
        Ok(())
    }

    /// Where the store lives on disk. Exposed for diagnostics and so
    /// the registry can hand the same directory to `Session::save_to_path`
    /// without having to reach inside the store.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// How this store arranges files. Needed by the conversation runtime,
    /// which derives the spill directory holding only the store's root.
    #[must_use]
    pub fn layout(&self) -> StoreLayout {
        self.layout
    }

    /// The directory holding `thread_id`'s files.
    ///
    /// The store root under [`StoreLayout::Flat`], since a flat thread's files
    /// sit directly in it. Its own subdirectory under
    /// [`StoreLayout::Folder`].
    #[must_use]
    pub fn thread_dir(&self, thread_id: &str) -> PathBuf {
        match self.layout {
            StoreLayout::Flat => self.dir.clone(),
            StoreLayout::Folder => self.dir.join(thread_id),
        }
    }

    /// Directory holding `thread_id`'s images, under [`StoreLayout::Folder`].
    ///
    /// `None` for a flat store, which has no notion of assets: Build-mode
    /// threads reference files in the user's workspace, they do not own copies.
    ///
    /// Every image the conversation holds lands here whatever door it came
    /// through — generated, pasted, or attached — so the edit tool addresses
    /// one namespace instead of guessing which of several it was handed.
    #[must_use]
    pub fn assets_dir(&self, thread_id: &str) -> Option<PathBuf> {
        self.owns_assets
            .then(|| self.dir.join(thread_id).join("assets"))
    }

    /// Create the directory `thread_id`'s files live in, if it is missing.
    ///
    /// Under [`StoreLayout::Flat`] that is the store root, which is what every
    /// write already did. Under [`StoreLayout::Folder`] it is the
    /// conversation's own directory, and without this every store-side write
    /// fails with `NotFound` on a conversation that has never been saved —
    /// which is all of them, once.
    ///
    /// `Session::append_to_path` and `Session::save_to_path` create their own
    /// parents already, so the JSONL is not why this exists; the metadata
    /// sidecar and the rich-results log are.
    fn ensure_dir_for(&self, thread_id: &str) -> Result<(), RuntimeError> {
        super::project_dir::validate_thread_id(thread_id)?;
        fs::create_dir_all(self.thread_dir(thread_id))?;
        Ok(())
    }

    /// Path to the JSONL message log for `thread_id`.
    #[must_use]
    pub fn session_path(&self, thread_id: &str) -> PathBuf {
        match self.layout {
            StoreLayout::Flat => self.dir.join(format!("{thread_id}.jsonl")),
            StoreLayout::Folder => self.thread_dir(thread_id).join("conversation.jsonl"),
        }
    }

    /// Path to the metadata sidecar for `thread_id`.
    #[must_use]
    pub fn meta_path(&self, thread_id: &str) -> PathBuf {
        match self.layout {
            StoreLayout::Flat => self.dir.join(format!("{thread_id}.meta.json")),
            StoreLayout::Folder => self.thread_dir(thread_id).join("meta.json"),
        }
    }

    /// Path to the full-fidelity tool-result sidecar for `thread_id`.
    /// One JSON-serialized [`RichToolResult`] per line, append-only.
    #[must_use]
    pub fn rich_path(&self, thread_id: &str) -> PathBuf {
        match self.layout {
            StoreLayout::Flat => self.dir.join(format!("{thread_id}.rich.jsonl")),
            StoreLayout::Folder => self.thread_dir(thread_id).join("rich.jsonl"),
        }
    }

    /// Directory holding spilled tool output for `thread_id`.
    ///
    /// A command that prints thousands of lines cannot fit in the model's
    /// context, but truncating it destroys information the model may need —
    /// and for a failing build the useful part is the tail, which a head-only
    /// clamp always drops. The full text is written here instead, and the
    /// tool result carries a preview plus this path, so the model can reach
    /// any part of it with the `file_read` and `grep` tools it already has.
    ///
    /// Thread-scoped, so `delete` clears it with the rest of the thread.
    #[must_use]
    pub fn tool_results_dir(&self, thread_id: &str) -> PathBuf {
        tool_results_dir_in(&self.dir, thread_id, self.layout)
    }

    /// Path to the optional Artifact Canvas sidecar for `thread_id`.
    #[must_use]
    pub fn artifacts_path(&self, thread_id: &str) -> PathBuf {
        match self.layout {
            StoreLayout::Flat => self.dir.join(format!("{thread_id}.artifacts.json")),
            StoreLayout::Folder => self.thread_dir(thread_id).join("artifacts.json"),
        }
    }

    #[must_use]
    pub fn artifacts_temp_path(&self, thread_id: &str) -> PathBuf {
        self.artifacts_path(thread_id)
            .with_extension("artifacts.json.tmp")
    }

    #[must_use]
    pub fn artifacts_backup_path(&self, thread_id: &str) -> PathBuf {
        self.artifacts_path(thread_id)
            .with_extension("artifacts.json.bak")
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
        self.list_summaries_filtered(None)
    }

    /// Like [`Self::list_summaries`] but scoped to a single project.
    ///
    /// When `workspace_root` is `Some(root)`, only threads whose
    /// metadata `workspace_root` equals `root` are returned — threads
    /// from other projects AND legacy unscoped threads (`workspace_root
    /// == None`) are excluded. This is what makes a conversation opened
    /// in `c:/xyz` invisible from `c:/yyz`.
    ///
    /// `None` returns every thread (the IDE's global chat history).
    /// List every thread, reading only the ones that changed since last time.
    ///
    /// The slow part of a listing was never the directory walk, it was that
    /// building each summary read a whole conversation end to end. That is
    /// work proportional to every message ever sent, repeated on every
    /// listing, on the path that draws the rail at boot.
    ///
    /// So summaries are cached in [`SessionIndex`], each stamped with the size
    /// and modified time of the conversation and its sidecar. A listing walks
    /// the directory, compares stamps, and re-reads only what moved. The walk
    /// itself is cheap in the flat layout because one directory read already
    /// carries the metadata for every file in it — checking a thousand threads
    /// costs one syscall batch, not a thousand file opens.
    ///
    /// The index is never trusted over the files: a stamp that does not match
    /// means re-read, and a row whose file is gone is dropped. Anything that
    /// fails here falls back to reading the conversations, which is what this
    /// always did.
    pub fn list_summaries_filtered(
        &self,
        workspace_root: Option<&str>,
    ) -> Result<Vec<SessionSummary>, RuntimeError> {
        let found = match self.scan_dir()? {
            Some(found) => found,
            None => return Ok(Vec::new()),
        };

        let index = SessionIndex::open(&self.dir);
        let cached = index
            .as_ref()
            .map(SessionIndex::load_all)
            .unwrap_or_default();

        let mut out = Vec::new();
        let mut rebuilt: Vec<(SessionSummary, Fingerprint)> = Vec::new();
        for thread in &found {
            let summary = match cached.get(&thread.id) {
                // Unchanged since it was cached: serve the row, open nothing.
                Some(hit) if hit.fingerprint == thread.fingerprint => hit.summary.clone(),
                _ => match self.summarize_thread(&thread.id, &thread.log) {
                    Ok(summary) => {
                        rebuilt.push((summary.clone(), thread.fingerprint));
                        summary
                    }
                    Err(err) => {
                        eprintln!(
                            "[SessionStore] failed to summarize {}: {err}; skipping",
                            thread.id
                        );
                        continue;
                    }
                },
            };
            self.keep_summary(&mut out, summary, workspace_root);
        }

        if let Some(index) = index.as_ref() {
            // Rows for threads that are no longer on disk — deleted through
            // Aurora, or removed underneath it.
            let present: std::collections::HashSet<&str> =
                found.iter().map(|t| t.id.as_str()).collect();
            let removed: Vec<String> = cached
                .keys()
                .filter(|id| !present.contains(id.as_str()))
                .cloned()
                .collect();
            index.apply(&rebuilt, &removed);
        }

        // Sort newest-first by RFC3339 string compare — works because
        // RFC3339 is lexicographically ordered.
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    /// Every conversation in the store, with the stamps that say whether a
    /// cached summary for it is still true.
    fn scan_dir(&self) -> Result<Option<Vec<FoundThread>>, RuntimeError> {
        let mut found = Vec::new();
        let read = match fs::read_dir(&self.dir) {
            Ok(r) => r,
            // Fresh install — store dir doesn't exist yet. Empty list,
            // not an error.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(RuntimeError::from(e)),
        };

        // Flat layout: every file lives in this one directory, so the walk
        // collects the sidecars' stamps on the way past instead of asking for
        // them again per thread. On Windows the metadata comes from the
        // directory enumeration itself, so it is already paid for.
        let mut meta_stamps: HashMap<String, (u64, i64)> = HashMap::new();
        let mut logs: Vec<(String, PathBuf, (u64, i64))> = Vec::new();

        for entry in read.flatten() {
            let path = entry.path();
            // A folder store's conversations ARE the subdirectories, so the
            // stem-matching below has nothing to do: one directory is one
            // conversation, and its log has a fixed name. `chats.db` and any
            // other loose file in the root are skipped by not being
            // directories, which is also why the index can live beside them.
            if self.layout == StoreLayout::Folder {
                let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                let log = self.session_path(id);
                let Ok(log_meta) = fs::metadata(&log) else {
                    continue; // not a conversation folder
                };
                if !log_meta.is_file() {
                    continue;
                }
                // One folder per conversation, so its sidecar is not in the
                // directory we just read and has to be asked for. Still two
                // stat calls against reading the whole conversation.
                let meta_stamp = fs::metadata(self.meta_path(id))
                    .as_ref()
                    .map(session_index::stamp)
                    .unwrap_or((0, 0));
                let log_stamp = session_index::stamp(&log_meta);
                found.push(FoundThread {
                    id: id.to_string(),
                    log,
                    fingerprint: Fingerprint {
                        log_size: log_stamp.0,
                        log_mtime: log_stamp.1,
                        meta_size: meta_stamp.0,
                        meta_mtime: meta_stamp.1,
                    },
                });
                continue;
            }

            // Flat layout. `<id>.meta.json` arrives in this same walk, so
            // remember its stamp rather than stat-ing it again later.
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if let Some(id) = name.strip_suffix(".meta.json") {
                    if let Ok(meta) = entry.metadata() {
                        meta_stamps.insert(id.to_string(), session_index::stamp(&meta));
                    }
                    continue;
                }
            }
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
            // `<id>.rich.jsonl` is a SIDECAR of `<id>` (full-fidelity tool
            // results, see `rich_path`), not a thread of its own. Its stem is
            // `<id>.rich`, which the guard above does not catch. Left in, every
            // sidecar was listed as a phantom thread: no metadata file of its
            // own, so it fell back to the title "New Chat" with timestamps
            // synthesised from the file's mtime — which sorted the whole set to
            // the TOP of the newest-first listing.
            if stem.ends_with(".rich") {
                continue;
            }

            let stamp = entry
                .metadata()
                .as_ref()
                .map(session_index::stamp)
                .unwrap_or((0, 0));
            logs.push((stem, path, stamp));
        }

        // The sidecar stamps are only complete once the whole directory has
        // been walked, because a `.meta.json` can be enumerated after the
        // `.jsonl` it belongs to.
        for (id, log, log_stamp) in logs {
            let meta_stamp = meta_stamps.get(&id).copied().unwrap_or((0, 0));
            found.push(FoundThread {
                id,
                log,
                fingerprint: Fingerprint {
                    log_size: log_stamp.0,
                    log_mtime: log_stamp.1,
                    meta_size: meta_stamp.0,
                    meta_mtime: meta_stamp.1,
                },
            });
        }

        Ok(Some(found))
    }

    /// Summarize one thread and push it onto `out`, unless it is an expired
    /// archive or belongs to another project.
    ///
    /// Shared by both layouts. The two scans disagree only about how a
    /// conversation is IDENTIFIED on disk — a filename stem or a directory
    /// name — and everything after that point is the same work. Keeping it in
    /// one place is what stops the retention sweep or the project filter from
    /// existing in one layout and quietly not the other.
    fn keep_summary(
        &self,
        out: &mut Vec<SessionSummary>,
        summary: SessionSummary,
        workspace_root: Option<&str>,
    ) {
        // Retention GC: an archived chat past its 15-day window is
        // purged here. Listing is the natural, frequent trigger, so
        // no background scheduler is needed. This runs before the
        // project filter so expired archives are reaped globally.
        if let Some(ts) = summary.archived_at.as_deref() {
            if archive_expired(ts) {
                if let Err(err) = self.delete(&summary.id) {
                    eprintln!(
                        "[SessionStore] failed to purge expired archive {}: {err}",
                        summary.id
                    );
                }
                return;
            }
        }
        // Project scoping: when a filter is set, drop threads
        // that don't belong to it (including unscoped ones).
        if let Some(want) = workspace_root {
            if summary
                .workspace_root
                .as_deref()
                .map(|root| super::project_dir::normalize(Path::new(root)))
                != Some(super::project_dir::normalize(Path::new(want)))
            {
                return;
            }
        }
        out.push(summary);
    }

    /// Build one [`SessionSummary`] for `thread_id`. Reads the
    /// sidecar for title/timestamps and the JSONL for messageCount +
    /// preview. Missing sidecar → synthesised defaults.
    fn summarize_thread(
        &self,
        thread_id: &str,
        jsonl_path: &Path,
    ) -> Result<SessionSummary, RuntimeError> {
        #[cfg(test)]
        SUMMARIZED_THREADS.with(|reads| reads.borrow_mut().push(thread_id.to_owned()));
        let meta = self
            .load_metadata(thread_id)
            .unwrap_or_else(|_| SessionMetadata::new(thread_id));

        // Stream the JSONL: count non-empty lines and remember the raw text
        // of the last line that starts a user message. Only that ONE line is
        // deserialized. This function used to call `Session::load_from_path`,
        // which builds every content block of every message — listing a
        // 193 MB store took multiple seconds and, run from a synchronous
        // command (main thread on Tauri v2/Windows), froze every window into
        // "Not Responding" at boot.
        //
        // The `{"role":"user"` prefix test is sound because `role` is the
        // first field of `ConversationMessage` and serde_json writes struct
        // fields in declaration order with no whitespace. A candidate line is
        // still verified by a real typed parse before use, so a false match
        // can only cost one extra parse, never a wrong preview.
        let (message_count, preview) = Self::scan_jsonl(jsonl_path).unwrap_or((0, String::new()));

        Ok(SessionSummary {
            id: thread_id.to_string(),
            title: meta.title,
            message_count,
            preview,
            workspace_root: meta.workspace_root,
            model: meta.model,
            pinned: meta.pinned,
            archived_at: meta.archived_at,
            deep_research: meta.deep_research,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
        })
    }

    /// Line-scan a session JSONL for `(message_count, preview)` without
    /// deserializing message bodies. See the caller for why.
    ///
    /// Any I/O failure degrades to the caller's `(0, "")` fallback — same
    /// behavior the old full-load path had for unreadable files — so a bad
    /// file can never make its thread disappear from the list.
    fn scan_jsonl(jsonl_path: &Path) -> io::Result<(usize, String)> {
        let file = fs::File::open(jsonl_path)?;
        let reader = BufReader::new(file);
        let mut message_count = 0usize;
        let mut last_user_line: Option<String> = None;
        for line_res in reader.lines() {
            let line = line_res?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            message_count += 1;
            if trimmed.starts_with(r#"{"role":"user""#) {
                last_user_line = Some(line);
            }
        }
        let preview = last_user_line
            .and_then(|line| serde_json::from_str::<ConversationMessage>(&line).ok())
            .filter(|m| matches!(m.role, MessageRole::User))
            .map(|m| collect_text_preview(&m.blocks, 120))
            .unwrap_or_default();
        Ok((message_count, preview))
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
            RuntimeError::InvalidState(format!("{} is malformed: {e}", path.display()))
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
        workspace_root: Option<String>,
    ) -> Result<SessionMetadata, RuntimeError> {
        self.ensure_dir_for(thread_id)?;

        // A folder conversation owns its images, so the directory exists from
        // the moment the conversation does. Created eagerly rather than on the
        // first write: every writer would otherwise have to remember, and the
        // one that forgets fails at exactly the wrong moment — after a 36-second
        // image generation, with the picture in hand and nowhere to put it.
        //
        // Best-effort. A conversation that cannot hold images is still a
        // conversation, and failing to create it here would stop the chat
        // existing at all.
        if let Some(assets) = self.assets_dir(thread_id) {
            if let Err(err) = fs::create_dir_all(&assets) {
                eprintln!(
                    "[SessionStore] could not create assets dir {}: {err}",
                    assets.display()
                );
            }
        }

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
        // A brand-new thread has no sidecar yet — its bootstrap metadata
        // MUST be persisted so the scope (workspace_root) sticks even
        // before the first turn runs.
        let mut dirty = !self.meta_path(thread_id).exists();
        let was_default = meta.title == "New Chat";
        if let Some(t) = title {
            if !t.is_empty() && (was_default || meta.title != t) {
                meta.title = t;
                meta.updated_at = chrono::Utc::now().to_rfc3339();
                dirty = true;
            }
        }
        // Tag the thread with its project at creation so it's scoped
        // immediately. Scope is set ONCE and is STICKY: `ensure_thread` runs
        // every turn with the turn's workspace, and OVERWRITING here silently
        // "moved" whole conversations to another project whenever that path
        // drifted (e.g. a repointed runtime workspace). Only adopt a workspace
        // when the thread has none yet (fresh, or a legacy unscoped thread
        // getting its first scope); a thread's project must never change as a
        // turn side effect.
        if let Some(ws) = workspace_root {
            let ws = ws.trim();
            if !ws.is_empty() && meta.workspace_root.as_deref().unwrap_or("").is_empty() {
                meta.workspace_root = Some(ws.to_string());
                dirty = true;
            }
        }
        if dirty {
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

    /// Toggle the pinned flag on the sidecar. No-op when unchanged.
    /// Deliberately does NOT bump `updated_at` — pinning shouldn't
    /// reorder the chat within its (pinned/unpinned) group by recency.
    pub fn set_pinned(
        &self,
        thread_id: &str,
        pinned: bool,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        if meta.pinned == pinned {
            return Ok(meta);
        }
        meta.pinned = pinned;
        self.save_metadata(&meta)?;
        Ok(meta)
    }

    /// Archive / unarchive a chat. Archiving stamps `archived_at` with the
    /// current instant (which also starts the 15-day retention clock);
    /// unarchiving clears it. No-op when already in the requested state.
    /// Deliberately does NOT bump `updated_at` — archiving shouldn't reorder
    /// the chat by recency.
    pub fn set_archived(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        if meta.archived_at.is_some() == archived {
            return Ok(meta);
        }
        meta.archived_at = if archived {
            Some(chrono::Utc::now().to_rfc3339())
        } else {
            None
        };
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
        // Scope is STICKY (see `ensure_thread`): adopt a workspace only when the
        // thread has none yet; never let a later turn's path overwrite an
        // existing scope — that repointed whole conversations to another project
        // whenever the runtime workspace drifted.
        if let Some(ws) = workspace_root {
            let ws = ws.trim();
            if !ws.is_empty() && meta.workspace_root.as_deref().unwrap_or("").is_empty() {
                meta.workspace_root = Some(ws.to_string());
                dirty = true;
            }
        }
        // The model is NOT sticky, unlike the scope above: it records the model
        // this conversation is currently on, so switching models mid-thread has
        // to move it. Write-once meant a thread was branded forever by whatever
        // model happened to run its first turn.
        if let Some(m) = model {
            if !m.is_empty() && meta.model.as_deref() != Some(m.as_str()) {
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

    /// Repair a Chat sidecar that acquired a Build workspace before surface
    /// ownership was enforced. A Chat conversation never has a workspace.
    pub fn clear_chat_workspace_root(&self, thread_id: &str) -> Result<(), RuntimeError> {
        super::project_dir::validate_thread_id(thread_id)?;
        if !self.owns_assets {
            return Err(RuntimeError::InvalidState(
                "cannot clear a Build conversation's workspace".into(),
            ));
        }
        let mut meta = self.load_metadata(thread_id)?;
        if meta.workspace_root.take().is_some() {
            self.save_metadata(&meta)?;
        }
        Ok(())
    }

    /// Pin this conversation to a model (`"providerId:modelKey"`).
    ///
    /// The counterpart to the per-turn write in [`Self::set_workspace_and_model`]:
    /// that one records what a turn actually ran on, this one records what the
    /// user chose BEFORE any turn — reopening an old chat, switching its model,
    /// and only then sending. Without it the choice would live nowhere until the
    /// turn completed, so navigating away and back would lose it.
    ///
    /// Does not bump `updated_at` — choosing a model isn't conversation
    /// activity and must not reorder the rail by recency (same rule as
    /// [`Self::set_pinned`]).
    pub fn set_model(
        &self,
        thread_id: &str,
        model: Option<String>,
    ) -> Result<SessionMetadata, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        let next = model.filter(|m| !m.is_empty());
        if meta.model == next {
            return Ok(meta);
        }
        meta.model = next;
        self.save_metadata(&meta)?;
        Ok(meta)
    }

    /// Mark a conversation as deep research, **once**.
    ///
    /// A no-op if it is already set, and it can never be unset. Deep research
    /// is how a conversation was framed: the prompt section it adds rides in
    /// the cacheable prefix, and turning it off mid-conversation would both
    /// contradict a transcript full of thorough answers and throw the whole
    /// conversation's prompt cache away.
    ///
    /// Returns whether this call was the one that set it.
    pub fn mark_deep_research(&self, thread_id: &str) -> Result<bool, RuntimeError> {
        let mut meta = self.load_metadata(thread_id)?;
        if meta.deep_research {
            return Ok(false);
        }
        meta.deep_research = true;
        self.save_metadata(&meta)?;
        Ok(true)
    }

    /// Is this conversation a deep-research one?
    ///
    /// Errors read as `false`: a missing sidecar means a conversation with no
    /// framing, and failing a turn over it would be the wrong trade.
    #[must_use]
    pub fn is_deep_research(&self, thread_id: &str) -> bool {
        self.load_metadata(thread_id)
            .map(|meta| meta.deep_research)
            .unwrap_or(false)
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

    /// Create an independent copy of a stored conversation.
    ///
    /// The transcript and full-fidelity tool-result sidecar are copied, while
    /// rail state is intentionally reset: a duplicate starts active and
    /// unpinned with fresh timestamps. Artifact Canvas data is owned by the
    /// artifacts command module and is copied there under its storage lock.
    pub fn duplicate(
        &self,
        source_thread_id: &str,
        new_thread_id: &str,
        title: String,
    ) -> Result<SessionMetadata, RuntimeError> {
        if self.exists(new_thread_id) || self.meta_path(new_thread_id).exists() {
            return Err(RuntimeError::InvalidState(format!(
                "thread {new_thread_id} already exists"
            )));
        }

        let loaded = self.load(source_thread_id)?.ok_or_else(|| {
            RuntimeError::InvalidState(format!("thread {source_thread_id} does not exist"))
        })?;

        let mut duplicate = Session::new(new_thread_id);
        if let Some(workspace_root) = loaded.metadata.workspace_root.as_deref() {
            duplicate = duplicate.with_workspace_root(workspace_root);
        }
        if let Some(model) = loaded.metadata.model.as_deref() {
            duplicate = duplicate.with_model(model);
        }
        for message in loaded.session.messages() {
            duplicate.append_message(message.clone());
        }

        self.ensure_dir_for(new_thread_id)?;
        if let Err(error) = duplicate.save_to_path(self.session_path(new_thread_id)) {
            let _ = self.delete(new_thread_id);
            return Err(error);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let metadata = SessionMetadata {
            thread_id: new_thread_id.to_string(),
            title,
            workspace_root: loaded.metadata.workspace_root,
            model: loaded.metadata.model,
            token_usage: loaded.metadata.token_usage,
            context_usage: loaded.metadata.context_usage,
            pinned: false,
            archived_at: None,
            // Carried, not reset. A duplicate of a deep-research conversation
            // holds a transcript of thorough, cited answers; opening it as an
            // ordinary chat would make every reply after the copy read as a
            // sudden drop in effort.
            deep_research: loaded.metadata.deep_research,
            created_at: now.clone(),
            updated_at: now,
        };

        if let Err(error) = self.save_metadata(&metadata) {
            let _ = self.delete(new_thread_id);
            return Err(error);
        }

        let source_rich = self.rich_path(source_thread_id);
        if source_rich.exists() {
            if let Err(error) = fs::copy(source_rich, self.rich_path(new_thread_id)) {
                let _ = self.delete(new_thread_id);
                return Err(RuntimeError::from(error));
            }
        }

        Ok(metadata)
    }

    /// Atomically replace the metadata sidecar. The actual JSONL is
    /// owned by `Session::save_to_path` / `Session::append_to_path`.
    fn save_metadata(&self, meta: &SessionMetadata) -> Result<(), RuntimeError> {
        self.ensure_dir_for(&meta.thread_id)?;
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

    /// Remove the JSONL and every thread-owned sidecar. Idempotent — a
    /// missing file is treated as success.
    /// Append full-fidelity tool results to the `.rich.jsonl` sidecar.
    /// Append-only and best-effort by design: a failed write costs the
    /// reload-time diff quality of ONE turn, never the conversation.
    pub fn append_rich_results(
        &self,
        thread_id: &str,
        entries: &[RichToolResult],
    ) -> Result<(), RuntimeError> {
        if entries.is_empty() {
            return Ok(());
        }
        self.ensure_dir_for(thread_id)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.rich_path(thread_id))?;
        for entry in entries {
            let line = serde_json::to_string(entry)?;
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
        }
        Ok(())
    }

    /// Load the rich sidecar as a `tool_use_id → content` map (last
    /// write wins). Missing file or malformed lines degrade to fewer
    /// entries, never an error — the clamped in-JSONL copy is always a
    /// valid fallback.
    #[must_use]
    pub fn load_rich_results(&self, thread_id: &str) -> HashMap<String, String> {
        let raw = match fs::read_to_string(self.rich_path(thread_id)) {
            Ok(s) => s,
            Err(_) => return HashMap::new(),
        };
        let mut map = HashMap::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<RichToolResult>(line) {
                map.insert(entry.tool_use_id, entry.content);
            }
        }
        map
    }

    pub fn delete(&self, thread_id: &str) -> Result<(), RuntimeError> {
        super::project_dir::validate_thread_id(thread_id)?;
        self.preserve_usage(thread_id)?;
        super::project_dir::forget(thread_id);
        // Drop the cached listing row with the files. A listing would notice
        // the absence on its own, but only after building a list that still
        // had the thread in it.
        if let Some(index) = SessionIndex::open(&self.dir) {
            index.forget(thread_id);
        }
        // A folder conversation is one directory, assets and all. Removing it
        // is the whole deletion, and it cannot leave an orphan behind the way
        // an unlink-six-files list can once somebody adds a seventh sidecar.
        if self.layout == StoreLayout::Folder {
            return match fs::remove_dir_all(self.thread_dir(thread_id)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(RuntimeError::from(e)),
            };
        }
        for path in [
            self.session_path(thread_id),
            self.meta_path(thread_id),
            self.rich_path(thread_id),
            self.artifacts_path(thread_id),
            self.artifacts_temp_path(thread_id),
            self.artifacts_backup_path(thread_id),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(RuntimeError::from(e)),
            }
        }
        // Spilled tool output is a directory, and it goes with the thread.
        match fs::remove_dir_all(self.tool_results_dir(thread_id)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(RuntimeError::from(e)),
        }
        Ok(())
    }
}

/// Where spilled tool output for `thread_id` lives under a store root.
///
/// Free-standing because the conversation runtime writes into it while
/// holding only the store's directory, not the store itself — and both must
/// agree on the layout or `delete` would leave the files behind. That is also
/// why `layout` is a parameter rather than inferred: probing the filesystem to
/// guess would answer differently before and after the directory exists, and
/// the one caller that must never disagree is `delete`.
#[must_use]
pub fn tool_results_dir_in(root: &Path, thread_id: &str, layout: StoreLayout) -> PathBuf {
    match layout {
        StoreLayout::Flat => root.join(format!("{thread_id}.tool-results")),
        StoreLayout::Folder => root.join(thread_id).join("tool-results"),
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
            // Strip embedded image markers so a pasted image's base64 payload
            // never leaks into the chat-list preview.
            let text = super::title::strip_aurora_image_blocks(text);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
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

    #[test]
    fn project_conversations_have_no_assets_but_chats_still_do() {
        let root = tempfile::tempdir().unwrap();
        let project = SessionStore::new_project(root.path().join("project"));
        let chat = SessionStore::new_folder(root.path().join("Chats"));
        project
            .ensure_thread("build", None, Some("E:/proj".into()))
            .unwrap();
        chat.ensure_thread("chat", None, None).unwrap();
        assert!(project.session_path("build").is_file());
        assert_eq!(project.assets_dir("build"), None);
        assert!(!project.thread_dir("build").join("assets").exists());
        assert!(chat.assets_dir("chat").unwrap().is_dir());
    }

    #[test]
    fn scoped_listing_matches_equivalent_windows_paths() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new_project(root.path().to_owned());
        store
            .ensure_thread("scoped", None, Some(r"E:\Project".into()))
            .unwrap();
        let listed = store.list_summaries_filtered(Some("e:/project/")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "scoped");
    }

    fn tmp_store() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn ensure_thread_creates_files_and_default_metadata() {
        let (_g, store) = tmp_store();
        let meta = store.ensure_thread("t1", None, None).expect("ensure");
        assert_eq!(meta.thread_id, "t1");
        assert_eq!(meta.title, "New Chat");
        assert!(store.session_path("t1").exists());
        assert!(store.meta_path("t1").exists());
    }

    #[test]
    fn list_summaries_returns_threads_sorted_newest_first() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread("a", Some("First".into()), None)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store
            .ensure_thread("b", Some("Second".into()), None)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.touch("a").unwrap();

        let summaries = store.list_summaries().unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "a", "touched thread sorts to top");
    }

    #[test]
    fn message_count_and_preview_come_from_jsonl() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread("p", Some("Title".into()), None)
            .unwrap();

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

    /// Listing caches its summaries so it stops reading every conversation on
    /// every call. These three pin the only thing that makes a cache safe: it
    /// has to notice when the files behind it move.
    ///
    /// Each one fails if the fingerprint stops watching the file it covers —
    /// drop the sidecar stamp and the rename test serves the old title; drop
    /// the conversation stamp and the new-message test serves the old count.
    mod cached_listing {
        use super::*;

        #[test]
        fn project_listing_ignores_shared_files_and_only_reads_changed_threads() {
            let root = tempfile::tempdir().unwrap();
            let store = SessionStore::new_project(root.path().to_owned());
            fs::write(root.path().join("project.json"), "{}").unwrap();
            fs::write(root.path().join("code-index.json"), "{}").unwrap();
            store
                .ensure_thread("a", Some("First".into()), None)
                .unwrap();
            store
                .ensure_thread("b", Some("Second".into()), None)
                .unwrap();
            SUMMARIZED_THREADS.with(|reads| reads.borrow_mut().clear());
            assert_eq!(store.list_summaries().unwrap().len(), 2);
            assert!(root.path().join("threads.db").is_file());
            SUMMARIZED_THREADS.with(|reads| {
                assert_eq!(reads.borrow().len(), 2);
                reads.borrow_mut().clear();
            });
            let reopened = SessionStore::new_project(root.path().to_owned());
            assert_eq!(reopened.list_summaries().unwrap().len(), 2);
            SUMMARIZED_THREADS.with(|reads| assert!(reads.borrow().is_empty()));
            Session::append_to_path(
                store.session_path("a"),
                &ConversationMessage::user_text("new message", 1),
            )
            .unwrap();
            let listed = reopened.list_summaries().unwrap();
            assert_eq!(
                listed.iter().find(|s| s.id == "a").unwrap().message_count,
                1
            );
            SUMMARIZED_THREADS.with(|reads| assert_eq!(*reads.borrow(), vec!["a".to_string()]));
        }

        #[test]
        fn a_listing_fills_the_index_and_the_next_one_agrees_with_it() {
            let (guard, store) = tmp_store();
            store
                .ensure_thread("a", Some("First".into()), None)
                .unwrap();
            store
                .ensure_thread("b", Some("Second".into()), None)
                .unwrap();

            let first = store.list_summaries().unwrap();
            let index = crate::agent_runtime::session_index::SessionIndex::open(guard.path())
                .expect("index");
            assert_eq!(index.len(), 2, "the listing should have cached both");

            // Served from the index this time: same answer, no conversation read.
            let second = store.list_summaries().unwrap();
            assert_eq!(
                serde_json::to_value(&first).unwrap(),
                serde_json::to_value(&second).unwrap(),
            );
        }

        #[test]
        fn renaming_a_chat_shows_up_on_the_next_listing() {
            // The title lives in the sidecar, which a rename rewrites without
            // touching the conversation at all.
            let (_g, store) = tmp_store();
            store.ensure_thread("r", Some("Draft".into()), None).unwrap();
            assert_eq!(store.list_summaries().unwrap()[0].title, "Draft");

            store.set_title("r", "Renamed".into()).unwrap();

            assert_eq!(store.list_summaries().unwrap()[0].title, "Renamed");
        }

        #[test]
        fn a_new_message_shows_up_on_the_next_listing() {
            let (_g, store) = tmp_store();
            store.ensure_thread("m", Some("Chat".into()), None).unwrap();

            let mut session = Session::new("m");
            session.append_message(ConversationMessage::user_text(
                "first question",
                chrono::Utc::now().timestamp_millis(),
            ));
            session.save_to_path(store.session_path("m")).unwrap();
            let before = store.list_summaries().unwrap();
            assert_eq!(before[0].message_count, 1);
            assert_eq!(before[0].preview, "first question");

            session.append_message(ConversationMessage::user_text(
                "second question",
                chrono::Utc::now().timestamp_millis(),
            ));
            session.save_to_path(store.session_path("m")).unwrap();

            let after = store.list_summaries().unwrap();
            assert_eq!(after[0].message_count, 2);
            assert_eq!(after[0].preview, "second question");
        }

        #[test]
        fn a_thread_deleted_underneath_aurora_leaves_the_listing() {
            // Not through `delete`, which drops the row itself — this is a
            // file removed by hand or by a sync tool, where the only thing
            // that can notice is the next listing.
            let (_g, store) = tmp_store();
            store.ensure_thread("gone", Some("Bye".into()), None).unwrap();
            store.ensure_thread("stays", Some("Here".into()), None).unwrap();
            assert_eq!(store.list_summaries().unwrap().len(), 2);

            std::fs::remove_file(store.session_path("gone")).unwrap();

            let listed = store.list_summaries().unwrap();
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].id, "stays");
        }
    }

    #[test]
    fn set_title_updates_metadata_and_bumps_updated_at() {
        let (_g, store) = tmp_store();
        let m1 = store.ensure_thread("x", None, None).unwrap();
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
        store.ensure_thread("u", None, None).unwrap();
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
    fn duplicate_copies_transcript_and_rich_results_with_fresh_rail_state() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread(
                "source",
                Some("Original".into()),
                Some("C:/work/project".into()),
            )
            .unwrap();
        store.set_pinned("source", true).unwrap();
        store.set_archived("source", true).unwrap();

        let mut session = Session::new("source").with_workspace_root("C:/work/project");
        session.append_message(ConversationMessage::user_text("hello", 1));
        session.append_message(ConversationMessage::assistant(
            vec![ContentBlock::Text {
                text: "hi".to_string(),
            }],
            2,
        ));
        session.save_to_path(store.session_path("source")).unwrap();
        store
            .append_rich_results(
                "source",
                &[RichToolResult {
                    tool_use_id: "call-1".into(),
                    tool: "file_edit".into(),
                    content: "full result".into(),
                }],
            )
            .unwrap();

        let metadata = store
            .duplicate("source", "copy", "Original (copy)".into())
            .unwrap();
        let copied = store.load("copy").unwrap().expect("copied session");

        assert_eq!(metadata.title, "Original (copy)");
        assert_eq!(metadata.workspace_root.as_deref(), Some("C:/work/project"));
        assert!(!metadata.pinned);
        assert!(metadata.archived_at.is_none());
        assert_eq!(copied.session.messages(), session.messages());
        assert_eq!(
            store
                .load_rich_results("copy")
                .get("call-1")
                .map(String::as_str),
            Some("full result")
        );
        assert!(store.load_metadata("source").unwrap().pinned);
        assert!(store.load_metadata("source").unwrap().archived_at.is_some());
    }

    #[test]
    fn delete_removes_jsonl_meta_and_artifacts() {
        let (_g, store) = tmp_store();
        store.ensure_thread("d", None, None).unwrap();
        std::fs::write(store.artifacts_path("d"), "{}").unwrap();
        std::fs::write(store.artifacts_temp_path("d"), "{}").unwrap();
        std::fs::write(store.artifacts_backup_path("d"), "{}").unwrap();
        assert!(store.session_path("d").exists());
        assert!(store.meta_path("d").exists());
        assert!(store.artifacts_path("d").exists());
        assert!(store.artifacts_temp_path("d").exists());
        assert!(store.artifacts_backup_path("d").exists());
        store.delete("d").unwrap();
        assert!(!store.session_path("d").exists());
        assert!(!store.meta_path("d").exists());
        assert!(!store.artifacts_path("d").exists());
        assert!(!store.artifacts_temp_path("d").exists());
        assert!(!store.artifacts_backup_path("d").exists());
    }

    #[test]
    fn delete_is_idempotent() {
        let (_g, store) = tmp_store();
        store.delete("nonexistent").expect("idempotent delete");
    }

    #[test]
    fn rich_results_append_load_last_wins_and_delete() {
        let (_g, store) = tmp_store();
        store.ensure_thread("r1", None, None).unwrap();

        store
            .append_rich_results(
                "r1",
                &[RichToolResult {
                    tool_use_id: "call-1".into(),
                    tool: "file_edit".into(),
                    content: "{\"v\":1}".into(),
                }],
            )
            .unwrap();
        store
            .append_rich_results(
                "r1",
                &[
                    RichToolResult {
                        tool_use_id: "call-1".into(),
                        tool: "file_edit".into(),
                        content: "{\"v\":2}".into(),
                    },
                    RichToolResult {
                        tool_use_id: "call-2".into(),
                        tool: "file_write".into(),
                        content: "full body".into(),
                    },
                ],
            )
            .unwrap();

        let map = store.load_rich_results("r1");
        assert_eq!(map.get("call-1").map(String::as_str), Some("{\"v\":2}"));
        assert_eq!(map.get("call-2").map(String::as_str), Some("full body"));

        // Missing sidecar degrades to empty, never errors.
        assert!(store.load_rich_results("missing").is_empty());
        // Empty batch is a no-op that must not create the file.
        store.append_rich_results("empty", &[]).unwrap();
        assert!(!store.rich_path("empty").exists());

        store.delete("r1").unwrap();
        assert!(!store.rich_path("r1").exists());
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
        store.ensure_thread("real", None, None).unwrap();
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(store.dir().join("real.jsonl.tmp"), "stale-rename-leftover").unwrap();
        let summaries = store.list_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "real");
    }

    /// A thread's rich-results sidecar is not a thread.
    ///
    /// `<id>.rich.jsonl` has the extension `jsonl` and the stem `<id>.rich`, so
    /// it clears the `.jsonl.tmp` guard. Every one that got through was listed
    /// as a phantom "New Chat" — and because its timestamps came from the
    /// file's mtime rather than a metadata sidecar, the phantoms sorted above
    /// every real conversation.
    #[test]
    fn list_summaries_skips_rich_results_sidecars() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread("real", Some("Real chat".into()), None)
            .unwrap();
        store
            .append_rich_results(
                "real",
                &[RichToolResult {
                    tool_use_id: "call-1".into(),
                    tool: "file_read".into(),
                    content: "full output".into(),
                }],
            )
            .unwrap();
        assert!(store.rich_path("real").exists(), "sidecar should exist");

        let summaries = store.list_summaries().unwrap();
        assert_eq!(
            summaries.len(),
            1,
            "the sidecar must not list as its own thread"
        );
        assert_eq!(summaries[0].id, "real");
        assert!(
            !summaries.iter().any(|s| s.id.ends_with(".rich")),
            "no phantom `<id>.rich` thread",
        );
    }

    #[test]
    fn ensure_thread_persists_workspace_root_at_create() {
        let (_g, store) = tmp_store();
        let meta = store
            .ensure_thread("w", Some("Scoped".into()), Some("C:/proj/xyz".into()))
            .unwrap();
        assert_eq!(meta.workspace_root.as_deref(), Some("C:/proj/xyz"));
        // Round-trips through the sidecar (scope sticks before any turn).
        let reloaded = store.load_metadata("w").unwrap();
        assert_eq!(reloaded.workspace_root.as_deref(), Some("C:/proj/xyz"));
    }

    #[test]
    fn workspace_scope_is_sticky_and_never_moves_on_a_later_turn() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread("w", Some("Scoped".into()), Some("C:/proj/A".into()))
            .unwrap();
        // A later turn running with a DIFFERENT workspace must NOT move the
        // thread — this is the "conversation jumped to another project" bug.
        store
            .set_workspace_and_model("w", Some("C:/proj/B".into()), Some("prov:model".into()))
            .unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().workspace_root.as_deref(),
            Some("C:/proj/A"),
        );
        // The per-turn `ensure_thread` re-affirmation is likewise sticky.
        store
            .ensure_thread("w", None, Some("C:/proj/B".into()))
            .unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().workspace_root.as_deref(),
            Some("C:/proj/A"),
        );
    }

    /// The counterpart to the scope rule above: the model is deliberately NOT
    /// sticky. A thread must follow the model it is currently being run on,
    /// otherwise it stays branded by whatever ran its very first turn.
    #[test]
    fn model_follows_the_latest_turn_rather_than_sticking_to_the_first() {
        let (_g, store) = tmp_store();
        store.ensure_thread("w", None, None).unwrap();
        store
            .set_workspace_and_model("w", None, Some("prov:alpha".into()))
            .unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().model.as_deref(),
            Some("prov:alpha"),
        );
        store
            .set_workspace_and_model("w", None, Some("other:beta".into()))
            .unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().model.as_deref(),
            Some("other:beta"),
        );
        // A turn that reports no model leaves the choice alone.
        store.set_workspace_and_model("w", None, None).unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().model.as_deref(),
            Some("other:beta"),
        );
    }

    #[test]
    fn set_model_pins_a_choice_before_any_turn_and_can_clear_it() {
        let (_g, store) = tmp_store();
        store.ensure_thread("w", None, None).unwrap();
        let before = store.load_metadata("w").unwrap().updated_at;
        assert_eq!(store.load_metadata("w").unwrap().model, None);

        store.set_model("w", Some("prov:alpha".into())).unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().model.as_deref(),
            Some("prov:alpha"),
        );
        // Choosing a model is not conversation activity — the rail must not
        // reorder by recency because someone opened the picker.
        assert_eq!(store.load_metadata("w").unwrap().updated_at, before);

        // It also reaches the chat list, which is what lets a reopened chat
        // show its own model instead of the last globally-picked one.
        let summaries = store.list_summaries().unwrap();
        let row = summaries.iter().find(|s| s.id == "w").unwrap();
        assert_eq!(row.model.as_deref(), Some("prov:alpha"));

        // An empty string is a cleared choice, not a model named "".
        store.set_model("w", Some(String::new())).unwrap();
        assert_eq!(store.load_metadata("w").unwrap().model, None);
    }

    #[test]
    fn legacy_unscoped_thread_still_adopts_first_scope() {
        let (_g, store) = tmp_store();
        store.ensure_thread("w", Some("Old".into()), None).unwrap();
        assert_eq!(store.load_metadata("w").unwrap().workspace_root, None);
        // A legacy unscoped thread SHOULD adopt a scope on its first turn.
        store
            .set_workspace_and_model("w", Some("C:/proj/A".into()), None)
            .unwrap();
        assert_eq!(
            store.load_metadata("w").unwrap().workspace_root.as_deref(),
            Some("C:/proj/A"),
        );
    }

    #[test]
    fn list_summaries_filtered_scopes_to_one_project_and_drops_unscoped() {
        let (_g, store) = tmp_store();
        store
            .ensure_thread("x1", Some("xyz one".into()), Some("C:/proj/xyz".into()))
            .unwrap();
        store
            .ensure_thread("y1", Some("yyz one".into()), Some("C:/proj/yyz".into()))
            .unwrap();
        // Legacy unscoped thread (created before scoping shipped).
        store
            .ensure_thread("legacy", Some("old".into()), None)
            .unwrap();

        let xyz = store.list_summaries_filtered(Some("C:/proj/xyz")).unwrap();
        assert_eq!(xyz.len(), 1, "only the xyz thread; yyz + legacy excluded");
        assert_eq!(xyz[0].id, "x1");
        assert_eq!(xyz[0].workspace_root.as_deref(), Some("C:/proj/xyz"));

        // Unfiltered still returns everything (IDE global history).
        let all = store.list_summaries().unwrap();
        assert_eq!(all.len(), 3);
    }

    // ------------------------------------------------------------------
    // Folder layout (Aurora Chat)
    // ------------------------------------------------------------------

    fn tmp_folder_store() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new_folder(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn folder_layout_puts_every_file_inside_the_conversations_own_directory() {
        let (guard, store) = tmp_folder_store();
        let root = guard.path();

        assert_eq!(store.session_path("c1"), root.join("c1/conversation.jsonl"));
        assert_eq!(store.meta_path("c1"), root.join("c1/meta.json"));
        assert_eq!(store.rich_path("c1"), root.join("c1/rich.jsonl"));
        assert_eq!(store.artifacts_path("c1"), root.join("c1/artifacts.json"));
        assert_eq!(store.tool_results_dir("c1"), root.join("c1/tool-results"));
        assert_eq!(store.assets_dir("c1"), Some(root.join("c1/assets")));
    }

    /// The flat store has no assets, and saying so is the point: a Build-mode
    /// thread references files in the user's workspace rather than owning
    /// copies of them, so there is no directory for it to answer with.
    #[test]
    fn flat_layout_has_no_assets_directory() {
        let (_g, store) = tmp_store();
        assert_eq!(store.assets_dir("t1"), None);
    }

    /// The two stores must not see each other's conversations even when they
    /// are handed the same thread id, because the id is all they share.
    #[test]
    fn the_two_layouts_are_separate_stores() {
        let (guard, flat) = tmp_store();
        let folder = SessionStore::new_folder(guard.path().join("Chats"));

        flat.ensure_thread("same-id", Some("a build thread".into()), None)
            .unwrap();
        folder
            .ensure_thread("same-id", Some("a chat".into()), None)
            .unwrap();

        assert_eq!(flat.load_metadata("same-id").unwrap().title, "a build thread");
        assert_eq!(folder.load_metadata("same-id").unwrap().title, "a chat");
    }

    #[test]
    fn folder_layout_lists_conversations_and_ignores_loose_files() {
        let (guard, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("first".into()), None).unwrap();
        store.ensure_thread("c2", Some("second".into()), None).unwrap();

        // `chats.db` lives in this same root. A listing that treated every
        // entry as a conversation would report it as one, so it has to be
        // skipped by not being a directory — not by being named.
        std::fs::write(guard.path().join("chats.db"), b"not a conversation").unwrap();
        // A directory with no log in it is not a conversation either. This is
        // what a half-created chat looks like on disk.
        std::fs::create_dir_all(guard.path().join("half-made")).unwrap();

        let listed = store.list_summaries().unwrap();
        let mut ids: Vec<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["c1", "c2"]);
    }

    /// Deleting a chat takes its assets with it. This is the whole reason the
    /// layout differs: the flat store's `delete` unlinks a fixed list of
    /// sidecars, and an image written next to them would survive it.
    #[test]
    fn folder_delete_removes_the_conversation_and_its_assets() {
        let (guard, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("chat".into()), None).unwrap();

        let assets = store.assets_dir("c1").expect("folder store has assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("generated-1.png"), b"pretend png").unwrap();

        store.delete("c1").unwrap();

        assert!(!guard.path().join("c1").exists(), "the whole folder goes");
        assert!(store.list_summaries().unwrap().is_empty());
    }

    #[test]
    fn folder_delete_of_a_missing_conversation_is_not_an_error() {
        let (_g, store) = tmp_folder_store();
        store.delete("never-existed").expect("delete is idempotent");
    }

    /// A chat owns its images from the moment it exists. Created eagerly so no
    /// writer has to remember — and the one that would forget is the image
    /// generator, which finds out 36 seconds in with a picture in hand.
    #[test]
    fn creating_a_chat_creates_its_assets_directory() {
        let (guard, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("a chat".into()), None).unwrap();

        let assets = guard.path().join("c1").join("assets");
        assert!(assets.is_dir(), "assets/ exists with the conversation");
    }

    /// An empty `assets/` must not make the conversation folder look like a
    /// conversation to the scanner, nor stop it being listed.
    #[test]
    fn an_assets_directory_does_not_confuse_the_listing() {
        let (_g, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("a chat".into()), None).unwrap();

        let listed = store.list_summaries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "c1");
    }

    // ------------------------------------------------------------------
    // Deep research — set once, at creation
    // ------------------------------------------------------------------

    #[test]
    fn a_conversation_is_not_deep_research_by_default() {
        let (_g, store) = tmp_folder_store();
        store.ensure_thread("c1", None, None).unwrap();
        assert!(!store.is_deep_research("c1"));
    }

    #[test]
    fn marking_deep_research_sticks_and_is_idempotent() {
        let (_g, store) = tmp_folder_store();
        store.ensure_thread("c1", None, None).unwrap();

        assert!(store.mark_deep_research("c1").unwrap(), "the first call sets it");
        assert!(store.is_deep_research("c1"));
        assert!(
            !store.mark_deep_research("c1").unwrap(),
            "the second call is a no-op and says so"
        );
        assert!(store.is_deep_research("c1"));
    }

    /// It survives a reload, because the whole point is that the conversation
    /// carries its own framing rather than reading a live setting.
    #[test]
    fn deep_research_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = SessionStore::new_folder(dir.path().to_path_buf());
            store.ensure_thread("c1", None, None).unwrap();
            store.mark_deep_research("c1").unwrap();
        }
        let reopened = SessionStore::new_folder(dir.path().to_path_buf());
        assert!(reopened.is_deep_research("c1"));
    }

    /// A sidecar written before this shipped has no such field. It must read as
    /// a normal conversation rather than failing to load.
    #[test]
    fn a_sidecar_without_the_field_loads_as_a_normal_chat() {
        let (guard, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("old".into()), None).unwrap();

        // Rewrite the sidecar without the field, as an older build would.
        // camelCase on purpose: that is the wire format the sidecar actually
        // uses, and writing snake_case here made this test fail for the wrong
        // reason the first time.
        let meta_path = store.meta_path("c1");
        let legacy = r#"{
            "threadId": "c1",
            "title": "old",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;
        std::fs::write(&meta_path, legacy).unwrap();
        assert!(guard.path().join("c1").exists());

        assert!(!store.is_deep_research("c1"));
        assert_eq!(store.load_metadata("c1").unwrap().title, "old");
    }

    /// A duplicate of a deep-research conversation keeps the framing. Its
    /// transcript is full of thorough, cited answers, and opening the copy as
    /// an ordinary chat would read as a sudden drop in effort.
    #[test]
    fn duplicating_a_deep_research_chat_keeps_it() {
        let (_g, store) = tmp_folder_store();
        store.ensure_thread("c1", Some("research".into()), None).unwrap();
        store.mark_deep_research("c1").unwrap();

        store.duplicate("c1", "c2", "research (copy)".into()).unwrap();

        assert!(store.is_deep_research("c2"));
    }

    #[test]
    fn marking_a_conversation_that_does_not_exist_does_not_panic() {
        let (_g, store) = tmp_folder_store();
        // `load_metadata` synthesises defaults for a missing sidecar, so this
        // writes one rather than erroring. What matters is that it is not a
        // panic and the answer is consistent afterwards.
        let _ = store.mark_deep_research("never-existed");
    }

    /// The flat store has no assets, so it must not sprout an empty directory.
    #[test]
    fn creating_a_build_thread_makes_no_assets_directory() {
        let (guard, store) = tmp_store();
        store.ensure_thread("t1", Some("a thread".into()), None).unwrap();
        assert!(!guard.path().join("assets").exists());
        assert!(!guard.path().join("t1").exists());
    }
}
