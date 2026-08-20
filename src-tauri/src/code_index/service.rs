//! Process-wide owner of built indexes, one per workspace.
//!
//! Deliberately a global singleton rather than a `ToolContext` field: the index
//! is inherently per-machine (like the shell process ledger, unlike a
//! conversation artifact), and threading a handle through ~25 construction
//! sites would buy nothing. Per-workspace scoping is internal to this type.
//!
//! Nothing here fails a caller's turn. Every entry point returns a `Result`,
//! and the tool layer turns an error into an honest "no index available"
//! message rather than a broken tool call — an agent that cannot use the index
//! must fall back to `grep`, not stop.

use super::persist;
use super::store::CodeIndex;
use anyhow::Result;
use dashmap::DashMap;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// Workspaces past this size are not indexed automatically. The build is
/// linear in file count, so a monorepo would stall the first turn instead of
/// answering it. The user can still force one from Settings — the guard exists
/// to keep the *automatic* path predictable, not to forbid the feature.
pub const AUTO_INDEX_MAX_FILES: usize = 25_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub workspace: String,
    pub built: bool,
    pub files: usize,
    pub symbols: usize,
    pub refs: usize,
    pub build_ms: u128,
    pub skipped_generated: usize,
    pub skipped_dirs: Vec<String>,
    pub cache_path: String,
    pub cache_bytes: u64,
}

/// The answer to "can this workspace be searched right now, and if not, what
/// would it cost to make it so".
///
/// Separate from [`IndexStatus`] because they answer different questions at
/// different prices. `status` describes what is already in memory and is free;
/// this walks the tree and adopts a still-valid cache, so it can distinguish
/// "never indexed" from "indexed last week and one file changed". A window that
/// offered to index an already-cached project would be nagging about nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProbe {
    /// An index is in memory and matches the tree on disk. Nothing to do.
    pub ready: bool,
    /// How many files a build would parse. Zero means this workspace holds
    /// nothing in a language the index reads, so offering to build one would
    /// promise an empty result.
    pub indexable_files: usize,
    /// Past [`AUTO_INDEX_MAX_FILES`], so no turn will ever build this on its
    /// own and an explicit build is the only way it gets one.
    pub over_auto_cap: bool,
}

#[derive(Default)]
pub struct CodeIndexService {
    indexes: DashMap<PathBuf, Arc<CodeIndex>>,
    /// Where cache files are written. `None` means the app's real
    /// `code-index/` directory.
    ///
    /// Exists so tests can point at a tempdir. The first version of this had no
    /// override, so every `cargo test` run wrote a dozen fixture caches into the
    /// user's actual AppData — found only because the directory was inspected
    /// by hand. A service that touches real user state must let a test say
    /// where.
    cache_root: Option<PathBuf>,
}

static SERVICE: OnceLock<CodeIndexService> = OnceLock::new();

pub fn service() -> &'static CodeIndexService {
    SERVICE.get_or_init(CodeIndexService::default)
}

/// Stable cache filename for a workspace.
///
/// Uses sha2 rather than `DefaultHasher` (which `checkpoints` uses) because the
/// std hasher's output is explicitly not stable across Rust releases — a
/// toolchain bump would silently orphan every cache file.
fn cache_key(workspace: &Path) -> String {
    use sha2::{Digest, Sha256};
    let normalized = workspace
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/");
    let digest = Sha256::digest(normalized.as_bytes());
    hex_16(&digest)
}

fn hex_16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

impl CodeIndexService {
    /// A service whose caches live under `root` instead of the app data
    /// directory.
    ///
    /// `#[cfg(test)]` because it is test-only by intent and nothing in the
    /// product should be choosing its own cache location — without the gate
    /// the non-test build reports it as dead code, which is misleading: the
    /// tests do use it, and they must, or they write a dozen fixture caches
    /// into the user's real AppData (see the 2026-08-09 lesson).
    #[cfg(test)]
    pub fn with_cache_root(root: PathBuf) -> Self {
        Self {
            indexes: DashMap::new(),
            cache_root: Some(root),
        }
    }

    fn cache_path(&self, workspace: &Path) -> PathBuf {
        let dir = match &self.cache_root {
            Some(r) => r.clone(),
            None => crate::paths::code_index_dir(),
        };
        dir.join(format!("{}.json", cache_key(workspace)))
    }

    /// The index for `workspace`, building it if this process has not yet.
    ///
    /// Order: memory, then the on-disk cache, then a fresh build. The cache is
    /// only a startup optimization — it is never trusted over an explicit
    /// [`rebuild`](Self::rebuild), and a corrupt or outdated one is silently
    /// replaced because losing it costs a sub-second rebuild.
    pub fn get_or_build(&self, workspace: &Path) -> Result<Arc<CodeIndex>> {
        let key = workspace.to_path_buf();
        if let Some(existing) = self.indexes.get(&key) {
            let idx = existing.clone();
            drop(existing);
            if !Self::is_stale(&idx, workspace) {
                return Ok(idx);
            }
            // Out of date — whoever changed the tree (the agent, the user in
            // another editor, a git checkout) does not have to have told us.
            return self.auto_rebuild(workspace, AUTO_INDEX_MAX_FILES);
        }

        let cache = self.cache_path(workspace);
        if let Ok(idx) = persist::load(&cache) {
            if !Self::is_stale(&idx, workspace) {
                let idx = Arc::new(idx);
                self.indexes.insert(key, idx.clone());
                return Ok(idx);
            }
        }

        self.auto_rebuild(workspace, AUTO_INDEX_MAX_FILES)
    }

    /// The automatic path's guarded build: refuse rather than stall a turn on
    /// a monorepo. The count comes from the same walk `is_stale` uses, so it
    /// reads no file contents. `cap` is a parameter only so a test does not
    /// have to create 25,001 files.
    fn auto_rebuild(&self, workspace: &Path, cap: usize) -> Result<Arc<CodeIndex>> {
        let (files, _) = super::walk::signature(workspace);
        if files > cap {
            anyhow::bail!(
                "workspace has {files} indexable files, past the automatic-index cap of {cap}; \
                 build it explicitly from Settings → Agent (Rebuild index)"
            );
        }
        self.rebuild(workspace)
    }

    /// Has the tree changed since this index was built?
    ///
    /// Compares a fresh walk fingerprint (file count + newest mtime) against
    /// the one recorded at build time. The walk reads no file contents, so this
    /// costs a small fraction of a rebuild and can run before every answer.
    ///
    /// mtime has one-second resolution, so an edit landing in the same second
    /// as the previous newest file is invisible here. That residual gap is why
    /// the `code` tool also exposes an explicit `refresh`.
    fn is_stale(idx: &CodeIndex, workspace: &Path) -> bool {
        Self::is_stale_against(idx, super::walk::signature(workspace))
    }

    /// The comparison on its own, for callers that already paid for a walk.
    fn is_stale_against(idx: &CodeIndex, signature: (usize, u64)) -> bool {
        // A zero fingerprint means the index predates this field; treat it as
        // stale once so it is rebuilt with one.
        if idx.stats.signature == (0, 0) {
            return true;
        }
        signature != idx.stats.signature
    }

    /// Is this workspace ready to answer, and if not, how big is the job?
    ///
    /// Walks the tree once and adopts a still-valid cache; it never parses a
    /// source file, so it is safe to call every time a project is opened.
    /// Adopting the cache is the point as much as the reporting is — a project
    /// indexed in an earlier session becomes answerable here, before the first
    /// message rather than during it.
    pub fn probe(&self, workspace: &Path) -> IndexProbe {
        let signature = super::walk::signature(workspace);
        let (indexable_files, _) = signature;
        IndexProbe {
            ready: self.adopt_current_cache(workspace, signature),
            indexable_files,
            over_auto_cap: indexable_files > AUTO_INDEX_MAX_FILES,
        }
    }

    /// True when an index for `workspace` is in memory and current, loading a
    /// matching cache to get there. Never builds.
    fn adopt_current_cache(&self, workspace: &Path, signature: (usize, u64)) -> bool {
        let key = workspace.to_path_buf();
        if let Some(existing) = self.indexes.get(&key) {
            let idx = existing.clone();
            drop(existing);
            return !Self::is_stale_against(&idx, signature);
        }
        match persist::load(&self.cache_path(workspace)) {
            Ok(idx) if !Self::is_stale_against(&idx, signature) => {
                self.indexes.insert(key, Arc::new(idx));
                true
            }
            _ => false,
        }
    }

    /// Build from source and replace whatever was cached.
    pub fn rebuild(&self, workspace: &Path) -> Result<Arc<CodeIndex>> {
        let idx = Arc::new(CodeIndex::build(workspace)?);
        // A failed cache write must not fail the build — the index is already
        // usable in memory, and the only cost is rebuilding next launch.
        if let Err(e) = persist::save(&idx, &self.cache_path(workspace)) {
            crate::logging::log_warn(
                "code_index",
                &format!("could not cache {}: {e:#}", workspace.display()),
            );
        }
        self.indexes.insert(workspace.to_path_buf(), idx.clone());
        Ok(idx)
    }

    /// What is currently known, without building anything. Drives the Settings
    /// panel, which must be able to say "not built yet" rather than trigger a
    /// build just by being opened.
    pub fn status(&self, workspace: &Path) -> IndexStatus {
        let cache = self.cache_path(workspace);
        let cache_bytes = std::fs::metadata(&cache).map(|m| m.len()).unwrap_or(0);
        match self.indexes.get(&workspace.to_path_buf()) {
            Some(idx) => IndexStatus {
                workspace: workspace.display().to_string(),
                built: true,
                files: idx.stats.files,
                symbols: idx.stats.symbols,
                refs: idx.stats.refs,
                build_ms: idx.stats.build_ms,
                skipped_generated: idx.stats.skipped_generated,
                skipped_dirs: idx.stats.skipped_dirs.clone(),
                cache_path: cache.display().to_string(),
                cache_bytes,
            },
            None => IndexStatus {
                workspace: workspace.display().to_string(),
                built: false,
                files: 0,
                symbols: 0,
                refs: 0,
                build_ms: 0,
                skipped_generated: 0,
                skipped_dirs: Vec::new(),
                cache_path: cache.display().to_string(),
                cache_bytes,
            },
        }
    }

    /// Drop a workspace's in-memory index so the next question re-parses.
    ///
    /// **Unfinished, not unused — do not delete it as dead code.** The intended
    /// caller is the turn loop, right after a file-mutating tool succeeds.
    /// Staleness is normally caught by [`is_stale`](Self::is_stale) comparing a
    /// fresh walk fingerprint, but mtime has one-second resolution, so an edit
    /// landing in the same second as the previously-newest file is invisible to
    /// it — which is the only reason `code { op: "refresh" }` has to exist.
    /// Calling this on every successful write would close that window and let
    /// the model stop thinking about refresh at all.
    ///
    /// Not wired yet because there is no single "a file changed" seam in
    /// `conversation.rs` to hang it on; adding one is the actual work.
    #[allow(dead_code)]
    pub fn invalidate(&self, workspace: &Path) {
        self.indexes.remove(&workspace.to_path_buf());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_are_stable_and_path_case_insensitive_on_windows_paths() {
        let a = cache_key(Path::new(r"E:\VOID-EDITOR\Aurora"));
        let b = cache_key(Path::new("E:/void-editor/aurora"));
        assert_eq!(a, b, "the same workspace must reuse one cache file");
        assert_eq!(a.len(), 16);
        assert_ne!(a, cache_key(Path::new("E:/other")));
    }

    #[test]
    fn status_reports_not_built_without_triggering_a_build() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn go() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));

        let before = svc.status(dir.path());
        assert!(!before.built, "opening Settings must not build an index");
        assert_eq!(before.symbols, 0);

        svc.rebuild(dir.path()).unwrap();
        let after = svc.status(dir.path());
        assert!(after.built && after.symbols > 0);
    }

    #[test]
    fn a_new_file_makes_the_index_rebuild_itself_with_nobody_telling_it() {
        // The whole point of the fingerprint: the agent, the user in another
        // editor, or a `git checkout` can all change the tree without emitting
        // anything we could listen for.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn first() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));
        let first = svc.get_or_build(dir.path()).unwrap();
        assert!(first.definitions("second").is_empty());

        std::fs::write(dir.path().join("b.rs"), "pub fn second() {}\n").unwrap();
        let after = svc.get_or_build(dir.path()).unwrap();
        assert_eq!(
            after.definitions("second").len(),
            1,
            "a file appeared and the index did not notice"
        );
    }

    #[test]
    fn an_untouched_workspace_is_not_rebuilt() {
        // The counterpart: if the fingerprint were unstable, every call would
        // rebuild and the cache would be pointless.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn only() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));
        let a = svc.get_or_build(dir.path()).unwrap();
        let b = svc.get_or_build(dir.path()).unwrap();
        assert!(
            Arc::ptr_eq(&a, &b),
            "unchanged tree must reuse the same index, not rebuild"
        );
    }

    #[test]
    fn a_workspace_past_the_cap_is_refused_automatically_but_builds_explicitly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        std::fs::write(dir.path().join("b.rs"), "pub fn two() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));

        let err = svc
            .auto_rebuild(dir.path(), 1)
            .expect_err("2 files against a cap of 1 must refuse");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("Settings"),
            "the refusal must name the explicit way forward: {msg}"
        );

        // The user's explicit rebuild ignores the cap entirely.
        let idx = svc.rebuild(dir.path()).unwrap();
        assert_eq!(idx.definitions("one").len(), 1);
    }

    #[test]
    fn probe_reports_an_unbuilt_workspace_without_building_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        std::fs::write(dir.path().join("b.go"), "package main\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));

        let p = svc.probe(dir.path());
        assert!(!p.ready, "nothing has been built yet");
        assert_eq!(p.indexable_files, 2);
        assert!(!p.over_auto_cap);
        assert!(
            !svc.status(dir.path()).built,
            "probing must never build — that is the whole point of asking first"
        );
    }

    #[test]
    fn probe_adopts_a_cache_from_an_earlier_session() {
        // The case that decides whether the window nags: a project indexed
        // yesterday is ready today, and must not be offered an index it
        // already has.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        let cache = dir.path().join(".cache");

        let first = CodeIndexService::with_cache_root(cache.clone());
        first.rebuild(dir.path()).unwrap();

        // A fresh service is a fresh process: memory is empty, only the cache
        // file survives.
        let next = CodeIndexService::with_cache_root(cache);
        assert!(!next.status(dir.path()).built, "memory starts empty");
        assert!(next.probe(dir.path()).ready, "the cache should be adopted");
        assert!(
            next.status(dir.path()).built,
            "adopting means the index is usable now, not merely present on disk"
        );
    }

    #[test]
    fn probe_reports_not_ready_once_the_tree_moves_on() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        let cache = dir.path().join(".cache");
        CodeIndexService::with_cache_root(cache.clone())
            .rebuild(dir.path())
            .unwrap();

        std::fs::write(dir.path().join("b.rs"), "pub fn two() {}\n").unwrap();
        let next = CodeIndexService::with_cache_root(cache);
        assert!(
            !next.probe(dir.path()).ready,
            "a stale cache is not readiness"
        );
    }

    #[test]
    fn a_workspace_with_no_readable_source_is_not_offered_an_index() {
        // Offering to index a folder of images would promise an empty result.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "hello\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));
        assert_eq!(svc.probe(dir.path()).indexable_files, 0);
    }

    #[test]
    fn invalidate_forces_a_fresh_read_of_changed_source() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        std::fs::write(&f, "pub fn before() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));
        assert_eq!(
            svc.get_or_build(dir.path())
                .unwrap()
                .definitions("before")
                .len(),
            1
        );

        std::fs::write(&f, "pub fn after() {}\n").unwrap();
        svc.invalidate(dir.path());
        // `get_or_build` would happily reload the *cache* it just wrote, which
        // is exactly the staleness this test exists to catch.
        let idx = svc.rebuild(dir.path()).unwrap();
        assert_eq!(idx.definitions("after").len(), 1);
        assert!(
            idx.definitions("before").is_empty(),
            "stale symbol survived"
        );
    }
}
