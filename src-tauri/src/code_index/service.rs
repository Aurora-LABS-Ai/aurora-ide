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
use anyhow::{Context, Result};
use dashmap::DashMap;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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
    pub reused_files: usize,
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
    workspaces: DashMap<PathBuf, Arc<WorkspaceState>>,
    /// Where cache files are written. `None` means the app's real
    /// `projects/` directory.
    ///
    /// Exists so tests can point at a tempdir. The first version of this had no
    /// override, so every `cargo test` run wrote a dozen fixture caches into the
    /// user's actual AppData — found only because the directory was inspected
    /// by hand. A service that touches real user state must let a test say
    /// where.
    cache_root: Option<PathBuf>,
}

#[derive(Default)]
struct WorkspaceState {
    /// Only this project's builders wait on this lock; other projects continue.
    build: Mutex<()>,
    revision: Mutex<Revision>,
}

#[derive(Default)]
struct Revision {
    current: u64,
    published: u64,
}

static SERVICE: OnceLock<CodeIndexService> = OnceLock::new();

pub fn service() -> &'static CodeIndexService {
    SERVICE.get_or_init(CodeIndexService::default)
}

/// One canonical in-memory key per workspace, however a caller spells the path.
///
/// The same normalization project directories use for identity — lowercase,
/// forward slashes — because the same divergence bites both places. The map
/// used the raw `PathBuf`, and one workspace reaches this service under at
/// least two spellings: the frontend's `projectRoot` (Settings → Rebuild, the
/// header offer) and the runtime session's `workspace_root` (repo map, the
/// `code` tool, the edit tools). Measured live: an index built from Settings
/// was invisible to `peek` from `file_edit`, so the edit-impact note never
/// fired in that workspace while working perfectly in one whose index was
/// built through the `code` tool.
fn map_key(workspace: &Path) -> PathBuf {
    PathBuf::from(crate::agent_runtime::project_dir::normalize(workspace))
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
            workspaces: DashMap::new(),
            cache_root: Some(root),
        }
    }

    fn project_dir(&self, workspace: &Path) -> Result<PathBuf> {
        if !workspace.is_dir() {
            anyhow::bail!("workspace is not a directory: {}", workspace.display());
        }
        let dirs = match &self.cache_root {
            Some(root) => crate::agent_runtime::project_dir::ProjectDirs::with_root(root.clone()),
            None => crate::agent_runtime::project_dir::projects(),
        };
        Ok(dirs.open_or_create(workspace)?)
    }

    /// Shared storage for this project's structural cache, build state,
    /// settings, and optional AI results. Project metadata resolves collisions.
    pub fn project_index_dir(&self, workspace: &Path) -> Result<PathBuf> {
        let directory = self.project_dir(workspace)?.join("code-index");
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("creating {}", directory.display()))?;
        Ok(directory)
    }

    fn cache_path(&self, workspace: &Path) -> Result<PathBuf> {
        Ok(self.project_index_dir(workspace)?.join("structural.json"))
    }

    fn workspace_state(&self, workspace: &Path) -> Arc<WorkspaceState> {
        self.workspaces
            .entry(map_key(workspace))
            .or_default()
            .clone()
    }

    fn load_cache(&self, workspace: &Path) -> Result<CodeIndex> {
        let cache = self.cache_path(workspace)?;
        // Retain the previous layout until the new file is fully written.
        // Older extraction formats are rebuilt, never deleted or rewritten in
        // place by migration.
        let index = match persist::load(&cache) {
            Ok(index) => index,
            Err(current) => {
                let legacy = self.project_dir(workspace)?.join("code-index.json");
                // The CURRENT file's error is the one that explains the state,
                // and it used to be discarded: a current cache one format
                // behind, beside a legacy file several behind, reported only
                // the legacy file's failure. Both are reported here, current
                // first, because "which of the two stopped this" is the whole
                // question.
                persist::load(&legacy).map_err(|fallback| {
                    current.context(format!(
                        "and the previous {} could not be read either: {fallback:#}",
                        legacy.display()
                    ))
                })?
            }
        };
        anyhow::ensure!(
            map_key(&index.root) == map_key(workspace),
            "cached index belongs to another workspace"
        );
        Ok(index)
    }

    /// Reuse a current index or build one. Concurrent callers for one project
    /// wait for the first builder and then reuse its published result.
    pub fn get_or_build(&self, workspace: &Path) -> Result<Arc<CodeIndex>> {
        let state = self.workspace_state(workspace);
        let _build = state
            .build
            .lock()
            .map_err(|_| anyhow::anyhow!("index build lock poisoned"))?;
        let signature = super::walk::signature_checked(workspace)?;
        if self.adopt_current_cache(workspace, signature, &state)? {
            return self
                .peek(workspace)
                .context("published index is unavailable");
        }
        anyhow::ensure!(super::jobs::settings(&self.project_index_dir(workspace)?)?.auto_build,
            "Automatic indexing is off for this project. Build its index in Settings → Agent → Code index, or use grep.");
        self.auto_rebuild_locked(workspace, AUTO_INDEX_MAX_FILES, &state)
    }

    #[cfg(test)]
    fn auto_rebuild(&self, workspace: &Path, cap: usize) -> Result<Arc<CodeIndex>> {
        let state = self.workspace_state(workspace);
        let _build = state.build.lock().unwrap();
        self.auto_rebuild_locked(workspace, cap, &state)
    }

    fn auto_rebuild_locked(
        &self,
        workspace: &Path,
        cap: usize,
        state: &WorkspaceState,
    ) -> Result<Arc<CodeIndex>> {
        let (files, _) = super::walk::discover(workspace);
        if files.len() > cap {
            anyhow::bail!(
                "workspace has {} indexable files, past the automatic-index cap of {cap}; \
                 build it explicitly from Settings → Agent (Rebuild index)",
                files.len()
            );
        }
        let previous = self.peek(workspace).or_else(|| self.load_cache(workspace).ok().map(Arc::new));
        self.rebuild_locked(workspace, state, |root| CodeIndex::build_incremental(root, previous.as_deref(), &|_, _, _| {}))
    }

    fn is_stale_against(idx: &CodeIndex, signature: (usize, u64)) -> bool {
        idx.stats.signature == (0, 0) || signature != idx.stats.signature
    }

    /// Probe content freshness without parsing or starting a build. A pending
    /// explicit invalidation always takes precedence over a matching cache.
    pub fn probe(&self, workspace: &Path) -> IndexProbe {
        let signature = match super::walk::signature_checked(workspace) {
            Ok(signature) => signature,
            Err(error) => {
                crate::logging::log_warn(
                    "code_index",
                    &format!("probing {}: {error:#}", workspace.display()),
                );
                return IndexProbe {
                    ready: false,
                    indexable_files: 0,
                    over_auto_cap: false,
                };
            }
        };
        let state = self.workspace_state(workspace);
        // Polling a build must not wait for the build it is reporting on.
        let ready = match state.build.try_lock() {
            Ok(_guard) => self
                .adopt_current_cache(workspace, signature, &state)
                .unwrap_or_else(|error| {
                    crate::logging::log_warn(
                        "code_index",
                        &format!("loading {}: {error:#}", workspace.display()),
                    );
                    false
                }),
            Err(_) => false,
        };
        IndexProbe {
            ready,
            indexable_files: signature.0,
            over_auto_cap: signature.0 > AUTO_INDEX_MAX_FILES,
        }
    }

    /// Caller holds the project's build lock, preventing cache adoption from
    /// overwriting a newer index while an explicit build publishes.
    fn adopt_current_cache(
        &self,
        workspace: &Path,
        signature: (usize, u64),
        state: &WorkspaceState,
    ) -> Result<bool> {
        let revision = state
            .revision
            .lock()
            .map_err(|_| anyhow::anyhow!("index revision lock poisoned"))?;
        if revision.current != revision.published {
            return Ok(false);
        }
        if let Some(existing) = self.indexes.get(&map_key(workspace)) {
            return Ok(!Self::is_stale_against(&existing, signature));
        }
        let index = match self.load_cache(workspace) {
            Ok(index) => index,
            Err(error) => {
                // Not ready, and previously not ready for no stated reason.
                // "Not indexed" over a project that was indexed minutes ago is
                // exactly the moment someone needs to know whether the cache
                // was written by an older format, belongs elsewhere, or could
                // not be read at all. Rebuilding is still the answer; the log
                // is what makes it an explanation instead of a guess.
                crate::logging::log_warn(
                    "code_index",
                    &format!(
                        "saved index for {} cannot be used, a build will replace it: {error:#}",
                        workspace.display()
                    ),
                );
                return Ok(false);
            }
        };
        if Self::is_stale_against(&index, signature) {
            return Ok(false);
        }
        let index = Arc::new(index);
        let cache = self.cache_path(workspace)?;
        if !cache.is_file() {
            // A valid legacy cache is copied forward without changing the old
            // file. Failure is explicit and leaves its previous owner intact.
            persist::save(&index, &cache)?;
        }
        self.indexes.insert(map_key(workspace), index);
        Ok(true)
    }

    /// Build only this workspace. No active-project UI state is consulted.
    pub fn rebuild(&self, workspace: &Path) -> Result<Arc<CodeIndex>> {
        let state = self.workspace_state(workspace);
        let _build = state
            .build
            .lock()
            .map_err(|_| anyhow::anyhow!("index build lock poisoned"))?;
        let previous = self.peek(workspace).or_else(|| self.load_cache(workspace).ok().map(Arc::new));
        self.rebuild_locked(workspace, &state, |root| CodeIndex::build_incremental(root, previous.as_deref(), &|_, _, _| {}))
    }

    /// Cancellation is checked around parsing and before publication. The
    /// parser's worker threads finish their current build without publishing it.
    pub fn rebuild_with_progress(
        &self, workspace: &Path, cancel: &tokio_util::sync::CancellationToken,
        progress: &(dyn Fn(usize, usize, &str) + Sync),
    ) -> Result<Arc<CodeIndex>> {
        let state = self.workspace_state(workspace);
        let _build = state
            .build
            .lock()
            .map_err(|_| anyhow::anyhow!("index build lock poisoned"))?;
        anyhow::ensure!(!cancel.is_cancelled(), "Build cancelled.");
        let previous = self.peek(workspace).or_else(|| self.load_cache(workspace).ok().map(Arc::new));
        self.rebuild_locked_checked(workspace, &state, |root| CodeIndex::build_incremental(root, previous.as_deref(), progress), || {
            cancel.is_cancelled()
        })
    }

    fn rebuild_locked(
        &self,
        workspace: &Path,
        state: &WorkspaceState,
        build: impl FnOnce(&Path) -> Result<CodeIndex>,
    ) -> Result<Arc<CodeIndex>> {
        self.rebuild_locked_checked(workspace, state, build, || false)
    }

    fn rebuild_locked_checked(
        &self,
        workspace: &Path,
        state: &WorkspaceState,
        build: impl FnOnce(&Path) -> Result<CodeIndex>,
        cancelled: impl Fn() -> bool,
    ) -> Result<Arc<CodeIndex>> {
        let started_revision = state
            .revision
            .lock()
            .map_err(|_| anyhow::anyhow!("index revision lock poisoned"))?
            .current;
        let before = super::walk::signature_checked(workspace)?;
        let index = Arc::new(build(workspace)?);
        // A few bad files never cost the whole project its index. The build is
        // published and names them: `coverage_gap` tells the model which files
        // are missing, so an absent usage there is not read as proof.
        if index.stats.files_failed > 0 {
            crate::logging::log_warn(
                "code_index",
                &format!(
                    "{}: indexed without {} file(s) that could not be read or parsed: {}",
                    workspace.display(),
                    index.stats.files_failed,
                    index.stats.failed_files.join(", ")
                ),
            );
        }
        let after = super::walk::signature_checked(workspace)?;
        anyhow::ensure!(
            before == after && index.stats.signature == after,
            "project changed while indexing; previous index retained, rebuild again"
        );
        let mut revision = state
            .revision
            .lock()
            .map_err(|_| anyhow::anyhow!("index revision lock poisoned"))?;
        anyhow::ensure!(
            revision.current == started_revision,
            "project was edited while indexing; previous index retained, rebuild again"
        );
        anyhow::ensure!(!cancelled(), "Build cancelled.");
        // Persist before changing memory, and hold the revision guard through
        // publication. A later invalidation remains dirty for the next query.
        persist::save(&index, &self.cache_path(workspace)?)?;
        self.indexes.insert(map_key(workspace), index.clone());
        revision.published = started_revision;
        Ok(index)
    }

    /// What is currently known, without building anything. Drives the Settings
    /// panel, which must be able to say "not built yet" rather than trigger a
    /// build just by being opened.
    pub fn status(&self, workspace: &Path) -> IndexStatus {
        let cache = self.cache_path(workspace).unwrap_or_else(|e| {
            crate::logging::log_warn(
                "code_index",
                &format!("cannot resolve cache for {}: {e:#}", workspace.display()),
            );
            PathBuf::new()
        });
        let cache_bytes = std::fs::metadata(&cache).map(|m| m.len()).unwrap_or(0);
        // Settings can describe a saved index before a query adopts it. It is
        // never inserted into the live map without a freshness check.
        let saved = if self.peek(workspace).is_none() { self.load_cache(workspace).ok() } else { None };
        let current = self.peek(workspace).or_else(|| saved.map(Arc::new));
        match current {
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
                reused_files: idx.stats.reused_files,
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
                reused_files: 0,
            },
        }
    }

    /// Record a write without evicting the pre-edit index used by impact notes.
    /// A build can only clear the revision it captured before reading source.
    pub fn invalidate(&self, workspace: &Path) {
        let state = self.workspace_state(workspace);
        let mut revision = state
            .revision
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        revision.current = revision.current.wrapping_add(1);
    }

    /// The index already in memory for `workspace`, if any. Never loads a
    /// cache, never walks, never builds — for callers (the edit-impact note)
    /// that must cost nothing when the index is not warm.
    pub fn peek(&self, workspace: &Path) -> Option<Arc<CodeIndex>> {
        self.indexes
            .get(&map_key(workspace))
            .map(|entry| entry.clone())
    }

    /// Serialize removal with automatic and manual builders; never recreate a
    /// cache after its files were deleted by an earlier in-flight build.
    pub fn remove_saved(&self, workspace: &Path, remove: impl FnOnce() -> Result<()>) -> Result<()> {
        let state = self.workspace_state(workspace);
        let _guard = state.build.try_lock().map_err(|_| anyhow::anyhow!("This project is being indexed. Try deleting after the build finishes."))?;
        remove()?;
        self.indexes.remove(&map_key(workspace));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Why does the header say "Not indexed" for a project that has a saved
    /// index on disk? `probe` answers with one boolean; this prints the two
    /// facts that boolean is made of, for a real workspace and the real saved
    /// cache — which a test cannot otherwise reach, because the projects root
    /// resolves to scratch space under `cfg(test)` so no test can write into
    /// the user's data.
    ///
    /// ```sh
    /// cd src-tauri
    /// AURORA_INDEX_ROOT="C:/path/to/project" \
    /// AURORA_PROJECTS_ROOT="$LOCALAPPDATA/AuroraIDE/projects" \
    ///   cargo test --lib why_this_workspace_is_not_ready -- --ignored --nocapture
    /// ```
    ///
    /// A signature mismatch means the tree moved since the build: the count is
    /// how many source files are found now, and the hash covers their contents
    /// plus the TypeScript configuration they resolve through. A load failure
    /// names itself, an older cache format being the usual one. If both agree,
    /// the index is fine and the panel reporting otherwise is the bug.
    ///
    /// Read-only: it never calls `probe`, which may copy a legacy cache
    /// forward, and never builds.
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT and AURORA_PROJECTS_ROOT pointing at a real workspace and its saved indexes"]
    fn why_this_workspace_is_not_ready() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let projects = std::env::var("AURORA_PROJECTS_ROOT").expect("set AURORA_PROJECTS_ROOT");
        let workspace = Path::new(&root);
        let service = CodeIndexService::with_cache_root(PathBuf::from(projects));

        let signature = super::super::walk::signature_checked(workspace);
        println!("workspace now : {signature:?}");
        match service.cache_path(workspace) {
            Ok(path) => println!(
                "cache file    : {} ({})",
                path.display(),
                if path.is_file() { "present" } else { "MISSING" }
            ),
            Err(error) => println!("cache file    : unresolvable: {error:#}"),
        }
        match service.load_cache(workspace) {
            Ok(index) => {
                println!("cache says    : {:?}", index.stats.signature);
                println!(
                    "verdict       : {}",
                    match signature {
                        Ok(now) if now == index.stats.signature =>
                            "READY — the saved index is current; a panel saying otherwise is wrong",
                        Ok(_) => "STALE — the tree changed since the build",
                        Err(ref error) => {
                            println!("workspace err : {error:#}");
                            "workspace could not be read"
                        }
                    }
                );
            }
            Err(error) => println!("verdict       : CACHE UNUSABLE — {error:#}"),
        }
    }

    #[test]
    fn manual_only_never_builds_or_serves_a_changed_index_automatically() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("source"); std::fs::create_dir(&workspace).unwrap();
        let source = workspace.join("a.ts"); std::fs::write(&source, "function first() {}\n").unwrap();
        let service = CodeIndexService::with_cache_root(temp.path().join("projects"));
        let directory = service.project_index_dir(&workspace).unwrap();
        super::super::jobs::save_settings(&directory, &super::super::jobs::IndexSettings { auto_build:false, ..Default::default() }).unwrap();
        assert!(service.get_or_build(&workspace).is_err());
        service.rebuild(&workspace).unwrap();
        assert!(service.get_or_build(&workspace).is_ok());
        std::fs::write(&source, "function other() {}\n").unwrap();
        assert!(service.get_or_build(&workspace).is_err());
    }

    #[test]
    fn removal_is_blocked_by_an_automatic_builder_and_clears_memory_afterwards() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeIndexService::with_cache_root(temp.path().join("projects"));
        let state = service.workspace_state(temp.path());
        let guard = state.build.lock().unwrap();
        assert!(service.remove_saved(temp.path(), || panic!("must not delete during a build")).is_err());
        drop(guard);
        std::fs::write(temp.path().join("a.ts"), "function f() {}\n").unwrap();
        service.rebuild(temp.path()).unwrap();
        assert!(service.peek(temp.path()).is_some());
        service.remove_saved(temp.path(), || Ok(())).unwrap();
        assert!(service.peek(temp.path()).is_none());
    }

    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real workspace"]
    fn fingerprint_cost_over_a_real_workspace() {
        let workspace =
            PathBuf::from(std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT"));
        for attempt in 0..5 {
            let start = std::time::Instant::now();
            let signature = super::super::walk::signature_checked(&workspace).unwrap();
            println!(
                "fingerprint {attempt}: {} files, {} ms",
                signature.0,
                start.elapsed().as_millis()
            );
        }
    }

    #[test]
    fn same_names_and_lossy_slug_collisions_keep_indexes_separate() {
        let root = tempfile::tempdir().unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        let paths = ["one/shared", "two/shared", "a/b", "a-b"];
        let mut cache_paths = std::collections::HashSet::new();
        for (n, path) in paths.iter().enumerate() {
            let workspace = root.path().join(path);
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::write(
                workspace.join("a.rs"),
                format!("pub fn project_{n}() {{}}\n"),
            )
            .unwrap();
            let index = svc.rebuild(&workspace).unwrap();
            assert_eq!(index.definitions(&format!("project_{n}")).len(), 1);
            assert!(cache_paths.insert(svc.cache_path(&workspace).unwrap()));
        }
        for (n, path) in paths.iter().enumerate() {
            let index = persist::load(&svc.cache_path(&root.path().join(path)).unwrap()).unwrap();
            assert_eq!(index.definitions(&format!("project_{n}")).len(), 1);
            assert_eq!(index.symbols.len(), 1);
        }
    }

    #[test]
    fn legacy_cache_is_copied_into_the_project_index_folder_without_deleting_it() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("a.rs"), "pub fn original() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        let legacy = svc.project_dir(&workspace).unwrap().join("code-index.json");
        persist::save(&CodeIndex::build(&workspace).unwrap(), &legacy).unwrap();
        let original = std::fs::read(&legacy).unwrap();
        assert!(svc.probe(&workspace).ready);
        assert_eq!(std::fs::read(&legacy).unwrap(), original);
        assert!(svc.cache_path(&workspace).unwrap().is_file());
        assert_eq!(
            svc.peek(&workspace).unwrap().definitions("original").len(),
            1
        );
    }

    #[test]
    fn dirty_probe_and_external_rename_do_not_serve_ready() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("old.rs"), "pub fn only() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        svc.rebuild(&workspace).unwrap();
        svc.invalidate(&workspace);
        assert!(
            !svc.probe(&workspace).ready,
            "an explicit edit always makes the index dirty"
        );
        svc.rebuild(&workspace).unwrap();
        std::fs::rename(workspace.join("old.rs"), workspace.join("new.rs")).unwrap();
        assert!(
            !svc.probe(&workspace).ready,
            "a rename preserves mtime but changes the index"
        );
        let current = svc.get_or_build(&workspace).unwrap();
        assert_eq!(current.files[0].path, "new.rs");
    }

    #[test]
    fn failed_or_edited_build_keeps_previous_memory_and_cache() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("a.rs"), "pub fn before() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        let original = svc.rebuild(&workspace).unwrap();
        let cache = svc.cache_path(&workspace).unwrap();
        let bytes = std::fs::read(&cache).unwrap();
        let state = svc.workspace_state(&workspace);
        let _guard = state.build.lock().unwrap();
        let failed = svc.rebuild_locked(&workspace, &state, |_| anyhow::bail!("interrupted"));
        assert!(failed.is_err());
        let edited = svc.rebuild_locked(&workspace, &state, |path| {
            let index = CodeIndex::build(path)?;
            svc.invalidate(path);
            Ok(index)
        });
        assert!(edited
            .unwrap_err()
            .to_string()
            .contains("edited while indexing"));
        let cancelled = svc.rebuild_locked_checked(&workspace, &state, CodeIndex::build, || true);
        assert!(cancelled.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(std::fs::read(&cache).unwrap(), bytes);
        assert!(Arc::ptr_eq(&original, &svc.peek(&workspace).unwrap()));
        assert!(!svc.probe(&workspace).ready);
    }

    #[test]
    fn an_external_write_during_a_build_rejects_the_new_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("a.rs"), "pub fn before() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        let original = svc.rebuild(&workspace).unwrap();
        let state = svc.workspace_state(&workspace);
        let _guard = state.build.lock().unwrap();
        let result = svc.rebuild_locked(&workspace, &state, |path| {
            let index = CodeIndex::build(path)?;
            std::fs::write(path.join("a.rs"), "pub fn after() {}\n")?;
            Ok(index)
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("changed while indexing"));
        assert!(Arc::ptr_eq(&original, &svc.peek(&workspace).unwrap()));
    }

    #[test]
    fn concurrent_automatic_queries_share_one_published_build() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("a.rs"), "pub fn shared() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(root.path().join("projects"));
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        svc.get_or_build(&workspace).unwrap()
                    })
                })
                .collect();
            let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
            assert!(results.iter().all(|index| Arc::ptr_eq(index, &results[0])));
        });
        assert!(svc.probe(&workspace).ready);
    }

    #[test]
    fn building_twenty_five_projects_keeps_every_project_cache() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let svc = CodeIndexService::with_cache_root(projects.clone());
        let mut first = None;
        for n in 0..25 {
            let workspace = root.path().join(format!("workspace-{n}"));
            std::fs::create_dir(&workspace).unwrap();
            std::fs::write(workspace.join("a.rs"), "pub fn only() {}\n").unwrap();
            svc.rebuild(&workspace).unwrap();
            let cache = svc.cache_path(&workspace).unwrap();
            assert_eq!(cache.file_name().unwrap(), "structural.json");
            assert_eq!(cache.parent().unwrap().file_name().unwrap(), "code-index");
            assert_eq!(
                cache.parent().unwrap().parent().unwrap().parent().unwrap(),
                projects
            );
            assert!(cache.is_file());
            if n == 0 {
                first = Some((cache.clone(), std::fs::read(&cache).unwrap()));
            }
        }
        let (path, bytes) = first.unwrap();
        assert_eq!(
            std::fs::read(path).unwrap(),
            bytes,
            "the 25th project must not evict or rewrite the first"
        );
    }

    #[test]
    fn an_old_format_is_replaced_at_the_same_project_path() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let projects = root.path().join("projects");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("a.rs"), "pub fn current() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(projects.clone());
        svc.rebuild(&workspace).unwrap();
        let cache = svc.cache_path(&workspace).unwrap();
        let mut old: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        old["version"] = 0.into();
        std::fs::write(&cache, serde_json::to_vec(&old).unwrap()).unwrap();
        let reopened = CodeIndexService::with_cache_root(projects);
        assert_eq!(
            reopened
                .get_or_build(&workspace)
                .unwrap()
                .definitions("current")
                .len(),
            1
        );
        assert!(persist::load(&cache).is_ok());
        let files: Vec<_> = std::fs::read_dir(cache.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(files.len(), 1, "only the replacement structural cache");
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
        assert!(next.peek(dir.path()).is_none(), "memory starts empty");
        assert!(next.status(dir.path()).built, "settings can describe the saved index");
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
        // The flag must be enough on its own — no explicit rebuild call.
        let idx = svc.get_or_build(dir.path()).unwrap();
        assert_eq!(idx.definitions("after").len(), 1);
        assert!(
            idx.definitions("before").is_empty(),
            "stale symbol survived"
        );
    }

    #[test]
    fn an_external_edit_with_preserved_mtime_rebuilds_without_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        std::fs::write(&f, "pub fn before() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));
        svc.get_or_build(dir.path()).unwrap();
        let original_mtime = std::fs::metadata(&f).unwrap().modified().unwrap();

        std::fs::write(&f, "pub fn after() {}\n").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(original_mtime)
            .unwrap();

        assert!(!svc.probe(dir.path()).ready);
        assert_eq!(
            svc.get_or_build(dir.path())
                .unwrap()
                .definitions("after")
                .len(),
            1,
            "content hashing must detect external writes even with the original mtime"
        );
    }

    #[test]
    fn a_nonexistent_workspace_is_refused_and_leaves_no_cache_behind() {
        let dir = tempfile::tempdir().unwrap();
        let cache_root = dir.path().join(".cache");
        let svc = CodeIndexService::with_cache_root(cache_root.clone());
        let ghost = dir.path().join("no-such-project");

        assert!(svc.rebuild(&ghost).is_err(), "rebuild must refuse");
        assert!(
            svc.get_or_build(&ghost).is_err(),
            "get_or_build must refuse"
        );
        let leftovers = std::fs::read_dir(&cache_root)
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(
            leftovers, 0,
            "a refused workspace must not write a cache file"
        );
    }

    #[test]
    fn every_spelling_of_a_workspace_reaches_one_index() {
        // The live failure: Settings → Rebuild stored the index under the
        // frontend's spelling of the root, and file_edit peeked with the
        // session's spelling — same directory, two keys, so the edit-impact
        // note never fired there. Windows treats these paths as one place;
        // the map must too.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));

        svc.rebuild(dir.path()).unwrap();

        let respelled = PathBuf::from(
            dir.path()
                .to_string_lossy()
                .to_uppercase()
                .replace('/', "\\"),
        );
        assert!(
            svc.peek(&respelled).is_some(),
            "a different case/separator spelling must find the same index"
        );
        assert!(
            svc.status(&respelled).built,
            "status must agree whichever spelling asks"
        );

        // And the dirty flag crosses spellings the same way.
        svc.invalidate(&respelled);
        std::fs::write(dir.path().join("a.rs"), "pub fn two() {}\n").unwrap();
        assert_eq!(
            svc.get_or_build(dir.path())
                .unwrap()
                .definitions("two")
                .len(),
            1,
            "a flag set under one spelling must be honoured under another"
        );
    }

    #[test]
    fn peek_serves_only_what_is_warm_and_never_builds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "pub fn one() {}\n").unwrap();
        let svc = CodeIndexService::with_cache_root(dir.path().join(".cache"));

        assert!(svc.peek(dir.path()).is_none(), "nothing is warm yet");
        assert!(
            !svc.status(dir.path()).built,
            "peeking must never have built anything"
        );

        svc.get_or_build(dir.path()).unwrap();
        let peeked = svc.peek(dir.path()).expect("warm after a build");
        assert_eq!(peeked.definitions("one").len(), 1);

        // The pre-edit index stays peekable after a write is flagged — it is
        // exactly what the edit-impact note reads.
        svc.invalidate(dir.path());
        assert!(svc.peek(dir.path()).is_some(), "the flag must not evict");
    }
}
