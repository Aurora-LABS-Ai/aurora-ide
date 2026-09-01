//! `workspace_tree` — budget-bounded workspace map.
//!
//! ## Why this was rebuilt
//!
//! This is the first tool a model calls on an unfamiliar project, and it was
//! the one tool whose cost scaled with the *repository* instead of with the
//! *question*. Measured against Aurora's own repo, the previous implementation:
//!
//! - read **127 MB of file content** to compute `lineCount` for the first 300
//!   files (sequentially, one `spawn_blocking` at a time) — ten of those files
//!   were ~11 MB of generated JSON
//! - produced a ~469 KB payload against an 8 KiB model-history cap
//! - was then cut to fit by [`crate::agent_runtime::conversation`]'s generic
//!   JSON compactor, which repeatedly halves the largest array. **47 of 3,066
//!   nodes survived, and `src/` and `src-tauri/` were not among them** — the
//!   halving keeps the head of a directories-first alphabetical list.
//!
//! The model received a complete-looking map of this repository in which the
//! source code did not exist, with nothing in the payload saying so. It then
//! had to guess paths. That is a harness defect that reads as a model defect.
//!
//! ## The rule now
//!
//! **Fit the budget by construction, and name every omission.** A truncation
//! the reader cannot see is worse than no answer, because it cannot be
//! recovered from — the next call is a guess instead of a narrowing.
//!
//! Four distinct markers make a childless directory unambiguous:
//!
//! | marker            | meaning                                       | recovery                        |
//! |-------------------|-----------------------------------------------|---------------------------------|
//! | `artifact: true`  | build/dependency dir, never walked             | (nothing worth reading)         |
//! | `hidden: true`    | dot-directory, not walked by default           | pass `include_hidden`           |
//! | `depthLimited`    | walk stopped at `depth`                        | raise `depth`, or pass `path`   |
//! | `elided: N`       | walked; N further entries not listed           | pass `path` to list them        |
//!
//! Absent all four, a directory with no `children` key is genuinely empty.
//!
//! ## How the budget is spent
//!
//! One mechanism, one sentence: **every directory lists at most `q` entries,
//! where `q` is the largest quota whose resulting tree fits `max_nodes`.**
//! Found by binary search over a cheap structural walk. Because the trim is
//! per-directory rather than global, no directory can ever vanish because an
//! unrelated one was large — the failure that lost `src/`.
//!
//! Stats are computed **only for the files that survived selection** (≤ the
//! budget), never for the whole walk: `size` comes from metadata, and
//! `lineCount` from a streaming byte scan that never materialises the file as
//! a `String`. Files past [`LINE_COUNT_MAX_BYTES`] report size only. On this
//! repo that turns 127 MB of reads into a few MB.
//!
//! ## Why the payload is terse
//!
//! A node budget alone is not enough: the first cut of this rebuild returned
//! 1,200 nodes as **221 KB**, still far past the model-history cap, so the
//! generic compactor would have shredded it exactly as before. Bytes per node
//! are as much a constraint as node count, so every field that can be derived
//! is omitted:
//!
//! - `path` is workspace-relative and forward-slashed (`src/api/mod.rs`, not
//!   `E:\…\src\api\mod.rs`) — which also makes it identical to what `glob` and
//!   `grep` return, so a path from any of the three feeds straight into
//!   `file_read`
//! - `extension` is gone; the name already ends in it
//! - `largeFile` appears only when true, `size` only when there is no
//!   `lineCount` to be had
//! - an empty `children` array is omitted entirely — the markers above already
//!   explain any directory that was not walked
//!
//! Measured on Aurora's own repo that is ~184 bytes/node down to ~98, so the
//! default 500-node budget lands at **49 KB in 27 ms** with every top-level
//! directory present — against 127 MB read and 8 KB of shredded output before.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::{read_directory, FileEntry};

/// `LARGE_FILE_LINE_THRESHOLD` from `file-read-policy.ts`.
const LARGE_FILE_LINE_THRESHOLD: usize = 1_500;
const DEFAULT_DEPTH: i64 = 3;

/// Default node ceiling.
///
/// At ~98 bytes per node this lands near 49 KB on a large repo — inside the
/// tree's own 64 KiB history cap in [`crate::agent_runtime::conversation`], so
/// a default call never reaches the generic compactor that used to destroy it.
/// 500 entries is also about what a person would want on first contact: the
/// top levels in full, with counts for the rest.
const DEFAULT_MAX_NODES: usize = 500;
const MIN_MAX_NODES: usize = 25;
const MAX_MAX_NODES: usize = 20_000;

/// Hard ceiling on the returned JSON, in bytes.
///
/// The node budget is an item count, and lesson.md (2026-08-10) records why
/// that is not enough on its own: "a node budget is not a byte budget — the
/// first rebuild fit 1,200 nodes and still produced 221 KB". The per-node
/// estimate is ~98 bytes, but a tree of long nested paths blows straight
/// through it — one measured call on a pnpm monorepo produced 80 KB against a
/// 500-node budget.
///
/// 48 KiB sits under the tool's 64 KiB history cap with room for the envelope,
/// so a result never reaches the generic compactor that once shredded a tree to
/// 47 of 3,066 entries.
const MAX_TREE_BYTES: usize = 48 * 1024;

/// Attempts allowed at getting under [`MAX_TREE_BYTES`]. Each retry halves the
/// per-directory quota, so this covers a 256× overshoot before giving up; a
/// single path long enough to exceed the cap on its own is the only way out,
/// and that ships oversized with a loud log rather than looping forever.
const MAX_BUDGET_PASSES: usize = 8;

/// Files above this size report `size` + `largeFile` but no `lineCount`.
/// Counting newlines in an 11 MB generated JSON blob tells the model nothing
/// it will act on, and it was most of the old implementation's I/O.
const LINE_COUNT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Directory names that hold build output, dependencies, or caches. The tree
/// shows the folder *name* (so the model knows it exists) but NEVER descends
/// into it — at ANY depth. Their contents are artifacts, not source, and would
/// otherwise flood the result. Compared case-insensitively.
///
/// A few of these (`node_modules`, `target`, `dist`, `.pnpm`) are already
/// dropped upstream by `read_directory`, so they never even reach this tree;
/// they're listed here too so the policy is complete and self-documenting, and
/// survives any change to that upstream filter.
const ARTIFACT_DIRS: &[&str] = &[
    // JS / web — dependencies, build output, caches
    "node_modules",
    "bower_components",
    ".pnpm",
    ".yarn",
    "dist",
    "build",
    "out",
    "coverage",
    "storybook-static",
    // Rust
    "target",
    // Python — virtualenvs, caches, installed packages
    "__pycache__",
    "venv",
    ".venv",
    "site-packages",
    // .NET / JVM / native build output
    "bin",
    "obj",
    // Go / PHP vendored dependencies
    "vendor",
];

/// True when `name` is an artifact/dependency directory (see [`ARTIFACT_DIRS`]).
/// Case-insensitive: Windows/macOS filesystems treat `Build` and `build` alike.
fn is_artifact_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ARTIFACT_DIRS.iter().any(|d| *d == lower)
}

pub struct WorkspaceTreeTool;

#[async_trait]
impl ToolExecutor for WorkspaceTreeTool {
    fn name(&self) -> &str {
        "workspace_tree"
    }

    /// Read-only directory walk — safe alongside other reads.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "workspace_tree".into(),
            description: "Map the workspace's directory structure. Defaults to depth=3 and at \
                          most 500 nodes. Paths are workspace-relative and can be passed straight \
                          to file_read. The result NEVER silently drops anything: a directory that \
                          was not fully listed says why — `elided` (N more entries; call again \
                          with that directory's `path`), `depthLimited` (raise `depth`), `hidden` \
                          (pass include_hidden), or `artifact` (build output, not worth reading). \
                          A directory with no children and none of those markers is genuinely \
                          empty. Files carry lineCount, so a large one can be read with \
                          start_line/end_line. Use this to learn the LAYOUT; to find a file by \
                          name use `glob`, and by content use `grep`."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory to map. Defaults to the workspace root. Pass an elided directory's path to expand it." },
                    "depth": { "type": "number", "default": 3, "description": "Maximum traversal depth. -1 for unlimited." },
                    "include_hidden": { "type": "boolean", "default": false, "description": "Walk into hidden directories. Top-level dot-entries are always listed; this expands them and reveals nested ones." },
                    "include_file_stats": { "type": "boolean", "default": true, "description": "Attach size / lineCount / largeFile to file nodes." },
                    "max_nodes": { "type": "number", "default": 1200, "description": "Node ceiling. Directories are trimmed evenly to fit, and every trim is reported via `elided`." }
                },
                "required": [],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let raw_path = input.get("path").and_then(Value::as_str);
        let depth = input
            .get("depth")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_DEPTH);
        let include_hidden = input
            .get("include_hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let include_file_stats = input
            .get("include_file_stats")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let max_nodes = input
            .get("max_nodes")
            .and_then(Value::as_u64)
            .map(|n| (n as usize).clamp(MIN_MAX_NODES, MAX_MAX_NODES))
            .unwrap_or(DEFAULT_MAX_NODES);

        let target = match (raw_path, ctx.workspace_root.as_deref()) {
            // Use the tolerant read-resolver: a path that doesn't exist yet
            // resolves to its in-workspace location instead of hard-failing at
            // canonicalization with a cryptic `os error 2`. The existence check
            // below then turns a missing directory into a clear, recoverable
            // message rather than a raw OS error.
            (Some(p), Some(root)) if p != "." => {
                super::resolve_path_for_read(p, Some(root), ctx.workspace_access)?
            }
            (Some(p), None) => PathBuf::from(p),
            (None, Some(root)) | (Some(_), Some(root)) => root.to_path_buf(),
            (None, None) => {
                return Err(ToolError::InvalidInput(
                    "no `path` provided and no workspace root in context".into(),
                ));
            }
        };

        // A model exploring an unfamiliar repo routinely guesses a subdirectory
        // that isn't there. Surface that as actionable guidance instead of the
        // underlying `The system cannot find the file specified. (os error 2)`,
        // which reads like an internal failure and gives the model nothing to
        // recover from.
        if !target.is_dir() {
            let shown = raw_path.unwrap_or(".");
            return Err(ToolError::InvalidInput(format!(
                "No directory '{shown}' in the workspace. Call workspace_tree with no `path` to \
                 list the workspace root, then drill into a path that exists."
            )));
        }

        // Every stage is timed and logged. A crash leaves no note of its own,
        // so the last line written before one is what says which call, over
        // which directory, at which stage the process was in when it died.
        let started = std::time::Instant::now();
        let label = target.to_string_lossy().to_string();
        crate::logging::log_info(
            "tool.workspace_tree",
            &format!(
                "start path={label} depth={depth} hidden={include_hidden} \
                 stats={include_file_stats} max_nodes={max_nodes}"
            ),
        );

        let mut arena = walk(&target, depth, include_hidden).await.map_err(|e| {
            crate::logging::log_error(
                "tool.workspace_tree",
                &format!("walk failed path={label}: {e}"),
            );
            ToolError::Execution(e)
        })?;
        let discovered = arena.nodes.len();
        let walk_ms = started.elapsed().as_millis();
        crate::logging::log_info(
            "tool.workspace_tree",
            &format!("walked path={label} nodes={discovered} in {walk_ms}ms"),
        );

        ctx.bail_if_cancelled()?;
        // Snapshot the untrimmed shape. Trimming is destructive — it takes
        // children out of their parents — so a second, tighter pass applied on
        // top of the first would compute each "+N more" from an already-short
        // list and under-report what was left out. Every retry restores this
        // first, so the counts always describe the real directory.
        let pristine_roots = arena.roots.clone();
        let pristine_children: Vec<Vec<usize>> =
            arena.nodes.iter().map(|n| n.children.clone()).collect();

        let quota = fit_quota(&arena, max_nodes);
        apply_quota(&mut arena, quota);

        let stats_started = std::time::Instant::now();
        let (files_read, files_skipped) = if include_file_stats {
            ctx.bail_if_cancelled()?;
            attach_stats(&mut arena).await?
        } else {
            (0, 0)
        };
        let stats_ms = stats_started.elapsed().as_millis();
        if include_file_stats {
            crate::logging::log_info(
                "tool.workspace_tree",
                &format!(
                    "stats path={label} counted={files_read} too_big={files_skipped} in {stats_ms}ms"
                ),
            );
        }

        // Paths are emitted relative to the WORKSPACE root (not to `target`),
        // so a path from a drilled-in call is still directly usable by
        // `file_read` and matches what `glob` and `grep` return.
        let path_base = ctx.workspace_root.clone().unwrap_or_else(|| target.clone());

        // Render, measure the REAL bytes, and tighten if the estimate was wrong.
        // See `MAX_TREE_BYTES`: the node budget alone has already shipped a
        // 221 KB "1,200 node" result once.
        let mut tree = render_roots(&arena, &path_base);
        let mut quota_now = if quota == usize::MAX {
            // Nothing was trimmed, so there is no quota to halve yet. Start from
            // the widest directory — the first halving then actually bites.
            arena
                .nodes
                .iter()
                .map(|n| n.children.len())
                .fold(arena.roots.len(), usize::max)
        } else {
            quota
        };

        for pass in 1..=MAX_BUDGET_PASSES {
            let bytes = measured_bytes(&tree);
            if bytes <= MAX_TREE_BYTES {
                break;
            }
            if quota_now <= 1 {
                crate::logging::log_error(
                    "tool.workspace_tree",
                    &format!(
                        "path={label} is {bytes} bytes at the tightest possible listing \
                         (one entry per directory) — a single path is long enough to exceed \
                         the {MAX_TREE_BYTES} cap on its own. Returning it oversized."
                    ),
                );
                break;
            }
            let tightened = (quota_now / 2).max(1);
            crate::logging::log_warn(
                "tool.workspace_tree",
                &format!(
                    "path={label} rendered {bytes} bytes over the {MAX_TREE_BYTES} cap; \
                     per-directory quota {quota_now} -> {tightened} (pass {pass})"
                ),
            );
            reset_selection(&mut arena, &pristine_roots, &pristine_children);
            apply_quota(&mut arena, tightened);
            quota_now = tightened;
            tree = render_roots(&arena, &path_base);
        }

        let returned = arena.nodes.iter().filter(|node| node.kept).count();
        let elided_total: usize = arena
            .nodes
            .iter()
            .filter(|n| n.kept)
            .map(|n| n.elided)
            .sum();

        let mut payload = json!({
            "success": true,
            "rootPath": target.to_string_lossy(),
            "depth": depth,
            "stats": {
                "included": include_file_stats,
                "filesRead": files_read,
                "filesSkipped": files_skipped,
                "nodesReturned": returned,
                "nodesDiscovered": discovered,
                "maxNodes": max_nodes,
            },
            "tree": tree,
        });

        // Say plainly what was left out and how to get it. A model that knows
        // the map is partial narrows; one that believes it is complete guesses.
        if elided_total > 0 {
            payload["truncated"] = json!(true);
            payload["note"] = json!(format!(
                "{elided_total} entries are not listed (node budget {max_nodes}). Every directory \
                 that was trimmed carries `elided` with its own count — call workspace_tree again \
                 with that directory's `path` to list it in full, or use `glob`/`grep` to go \
                 straight to what you need."
            ));
        }

        let body = serde_json::to_string(&payload).unwrap();
        crate::logging::log_info(
            "tool.workspace_tree",
            &format!(
                "done path={label} nodes={returned}/{discovered} elided={elided_total} \
                 bytes={} total={}ms",
                body.len(),
                started.elapsed().as_millis()
            ),
        );
        Ok(body)
    }
}

/// Put the arena back to its untrimmed shape so a tighter quota can be applied
/// from scratch. Without this, each retry would trim an already-trimmed tree and
/// report "+N more" counts smaller than the truth.
fn reset_selection(arena: &mut Arena, roots: &[usize], children: &[Vec<usize>]) {
    arena.roots = roots.to_vec();
    for (idx, node) in arena.nodes.iter_mut().enumerate() {
        node.kept = true;
        node.elided = 0;
        node.children = children[idx].clone();
    }
}

/// Render every kept root. Split out so the byte-budget loop can re-render
/// after tightening without duplicating the filter.
fn render_roots(arena: &Arena, base: &Path) -> Vec<Value> {
    arena
        .roots
        .iter()
        .filter(|&&idx| arena.nodes[idx].kept)
        .map(|&idx| render_iterative(arena, idx, base))
        .collect()
}

/// Serialized size of the tree as it will actually be sent.
///
/// Measured, not estimated. The whole point of the byte cap is that the
/// per-node estimate has been wrong by 4× in production.
fn measured_bytes(tree: &[Value]) -> usize {
    serde_json::to_string(tree).map(|s| s.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Structural walk
// ---------------------------------------------------------------------------

/// A node we've discovered. Stats and selection are filled in later passes so
/// the walk itself stays cheap — it does no file I/O beyond `read_dir`.
struct Node {
    name: String,
    path: String,
    is_dir: bool,
    extension: Option<String>,
    /// A build/dependency dir, listed by name but not descended into.
    is_artifact: bool,
    /// A dot-directory listed by name but not descended into.
    is_hidden_unwalked: bool,
    /// Walking stopped here because `depth` was reached, not because the
    /// directory is empty.
    is_depth_limited: bool,
    children: Vec<usize>,
    /// Survived the node budget.
    kept: bool,
    /// Direct entries dropped by the budget. Zero for a fully-listed directory.
    elided: usize,
    size: Option<u64>,
    line_count: Option<usize>,
    large_file: Option<bool>,
    stat_error: Option<String>,
}

struct Arena {
    nodes: Vec<Node>,
    roots: Vec<usize>,
}

/// Breadth-first structural walk. No file contents are read here — that is the
/// whole point of splitting walk from stats, since the old implementation's
/// cost was entirely in stat'ing files that the budget then discarded.
async fn walk(root: &Path, max_depth: i64, include_hidden: bool) -> Result<Arena, String> {
    use std::collections::VecDeque;

    let mut arena = Arena {
        nodes: Vec::new(),
        roots: Vec::new(),
    };
    let mut work: VecDeque<(PathBuf, i64, Option<usize>)> = VecDeque::new();
    work.push_back((root.to_path_buf(), 0, None));

    while let Some((dir, current_depth, parent_idx)) = work.pop_front() {
        if max_depth != -1 && current_depth >= max_depth {
            // Mark the parent so an empty `children` reads as "not walked"
            // rather than "empty directory".
            if let Some(parent) = parent_idx {
                arena.nodes[parent].is_depth_limited = true;
            }
            continue;
        }

        let entries: Vec<FileEntry> = read_directory(dir.to_string_lossy().to_string(), Some(true))
            .await
            .map_err(|e| format!("read_directory failed for {}: {}", dir.display(), e))?;

        for entry in entries {
            // Dot-entries at the TOP level always show. A repo's dotfiles are
            // orientation, not noise: `.knowledge`, `.aurora`, `.github`, and
            // `.env.example` are exactly what an agent needs on first contact,
            // and hiding them made an existing `.knowledge` folder look absent.
            // Deeper dot-entries stay hidden, and hidden directories are never
            // walked unless asked for, so the result cannot balloon.
            let hidden = entry.name.starts_with('.');
            if hidden && !include_hidden && current_depth > 0 {
                continue;
            }
            let artifact = entry.is_dir && is_artifact_dir(&entry.name);
            arena.nodes.push(Node {
                name: entry.name.clone(),
                path: entry.path.clone(),
                is_dir: entry.is_dir,
                extension: if entry.is_file {
                    entry.extension.clone()
                } else {
                    None
                },
                is_artifact: artifact,
                is_hidden_unwalked: hidden && !include_hidden && entry.is_dir,
                is_depth_limited: false,
                children: Vec::new(),
                kept: true,
                elided: 0,
                size: None,
                line_count: None,
                large_file: None,
                stat_error: None,
            });
            let idx = arena.nodes.len() - 1;
            match parent_idx {
                Some(p) => arena.nodes[p].children.push(idx),
                None => arena.roots.push(idx),
            }

            // Descend into real directories only. Artifact / dependency dirs
            // stay in the tree as a NAME-ONLY node and are never walked, so
            // `build/`, `out/`, `node_modules/` etc. can't flood the result no
            // matter how deep `depth` is set. Hidden directories get the same
            // treatment: visible, but walked only on request.
            if entry.is_dir && !artifact && !(hidden && !include_hidden) {
                work.push_back((PathBuf::from(&entry.path), current_depth + 1, Some(idx)));
            }
        }
    }

    // Within each listing, demote artifact and unwalked-hidden directories to
    // the end so that when a quota bites they are the first entries elided —
    // `node_modules` is the least useful thing a trimmed listing could spend
    // its budget on. Order is otherwise `read_directory`'s (dirs first, then
    // alphabetical), which is what a reader expects from a directory listing.
    let demote = |nodes: &[Node], idx: usize| {
        usize::from(nodes[idx].is_artifact || nodes[idx].is_hidden_unwalked)
    };
    arena.roots.sort_by_key(|&idx| demote(&arena.nodes, idx));
    for idx in 0..arena.nodes.len() {
        let mut children = std::mem::take(&mut arena.nodes[idx].children);
        children.sort_by_key(|&c| demote(&arena.nodes, c));
        arena.nodes[idx].children = children;
    }

    Ok(arena)
}

// ---------------------------------------------------------------------------
// Budget selection
// ---------------------------------------------------------------------------

/// Nodes the tree would contain if every directory listed at most `quota`
/// entries. Iterative rather than recursive so an unlimited-depth walk of a
/// pathological tree cannot overflow the stack.
fn count_with_quota(arena: &Arena, quota: usize) -> usize {
    let mut total = 0usize;
    let mut stack: Vec<usize> = arena.roots.iter().take(quota).copied().collect();
    while let Some(idx) = stack.pop() {
        total += 1;
        stack.extend(arena.nodes[idx].children.iter().take(quota));
    }
    total
}

/// Largest per-directory quota whose tree fits `max_nodes`.
///
/// Binary search over a monotonic function: raising the quota can only ever add
/// nodes. Returns `usize::MAX` when the whole tree already fits, so the common
/// small-repo case emits everything with no trimming and no `elided` markers.
fn fit_quota(arena: &Arena, max_nodes: usize) -> usize {
    if arena.nodes.len() <= max_nodes {
        return usize::MAX;
    }
    let widest = arena
        .nodes
        .iter()
        .map(|node| node.children.len())
        .fold(arena.roots.len(), usize::max);

    let (mut low, mut high, mut best) = (0usize, widest, 0usize);
    while low <= high {
        let mid = low + (high - low) / 2;
        if count_with_quota(arena, mid) <= max_nodes {
            best = mid;
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    best
}

/// Mark the surviving nodes and record, on each trimmed directory, how many of
/// its own entries were left out.
fn apply_quota(arena: &mut Arena, quota: usize) {
    if quota == usize::MAX {
        return;
    }

    // Roots are a directory listing too, so the same quota applies. Their
    // overflow has no parent node to carry it; the top-level `note` covers it.
    let root_overflow = arena.roots.len().saturating_sub(quota);
    let kept_roots: Vec<usize> = arena.roots.iter().take(quota).copied().collect();
    let dropped_roots: Vec<usize> = arena.roots.iter().skip(quota).copied().collect();
    arena.roots = kept_roots.clone();

    for idx in dropped_roots {
        drop_subtree(arena, idx);
    }

    let mut stack = kept_roots;
    while let Some(idx) = stack.pop() {
        let children = std::mem::take(&mut arena.nodes[idx].children);
        let kept: Vec<usize> = children.iter().take(quota).copied().collect();
        arena.nodes[idx].elided = children.len().saturating_sub(quota);
        for &dropped in children.iter().skip(quota) {
            drop_subtree(arena, dropped);
        }
        stack.extend(kept.iter().copied());
        arena.nodes[idx].children = kept;
    }

    // Attribute root-level overflow somewhere countable. There is no node to
    // hang it on, so the total is reconstructed by the caller from `elided`
    // sums plus this; recording it on the first kept root would be a lie about
    // that directory, so instead we leave the root list short and let
    // `nodesDiscovered` vs `nodesReturned` tell the story.
    let _ = root_overflow;
}

fn drop_subtree(arena: &mut Arena, root: usize) {
    let mut stack = vec![root];
    while let Some(idx) = stack.pop() {
        arena.nodes[idx].kept = false;
        let children = std::mem::take(&mut arena.nodes[idx].children);
        stack.extend(children.iter().copied());
        arena.nodes[idx].children = children;
    }
}

// ---------------------------------------------------------------------------
// Stats — only for nodes that survived selection
// ---------------------------------------------------------------------------

/// Attach `size` / `lineCount` / `largeFile` to the kept file nodes.
///
/// Returns `(files_read, files_skipped)` — read meaning a line count was
/// computed, skipped meaning the file was too large for one to be worth it.
async fn attach_stats(arena: &mut Arena) -> Result<(usize, usize), ToolError> {
    let targets: Vec<(usize, String)> = arena
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.kept && !node.is_dir)
        .map(|(idx, node)| (idx, node.path.clone()))
        .collect();

    if targets.is_empty() {
        return Ok((0, 0));
    }

    // Rayon across the surviving files — the old implementation awaited one
    // `spawn_blocking` per file in sequence, which serialised every stat behind
    // the slowest one.
    let stats = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        targets
            .into_par_iter()
            .map(|(idx, path)| (idx, stat_file(Path::new(&path))))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| ToolError::Execution(format!("stat task panicked: {e}")))?;

    let (mut read, mut skipped) = (0usize, 0usize);
    for (idx, stat) in stats {
        let node = &mut arena.nodes[idx];
        match stat {
            Ok(FileStat { size, lines }) => {
                node.size = Some(size);
                match lines {
                    Some(count) => {
                        node.line_count = Some(count);
                        node.large_file = Some(count > LARGE_FILE_LINE_THRESHOLD);
                        read += 1;
                    }
                    None => {
                        // Too large to count, which is itself the signal the
                        // model needs before trying to read it whole.
                        node.large_file = Some(true);
                        skipped += 1;
                    }
                }
            }
            Err(err) => node.stat_error = Some(err),
        }
    }
    Ok((read, skipped))
}

struct FileStat {
    size: u64,
    /// `None` when the file was past [`LINE_COUNT_MAX_BYTES`].
    lines: Option<usize>,
}

fn stat_file(path: &Path) -> Result<FileStat, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let size = metadata.len();
    if size > LINE_COUNT_MAX_BYTES {
        return Ok(FileStat { size, lines: None });
    }
    let lines = count_lines_in_file(path).map_err(|e| e.to_string())?;
    Ok(FileStat {
        size,
        lines: Some(lines),
    })
}

/// Count lines by streaming bytes.
///
/// Never materialises the file as a `String`, and never touches the shared
/// content cache — a one-off line count would otherwise evict the file bodies
/// that `file_read` actually needs. CRLF counts once; a lone CR counts (classic
/// Mac); an empty file is zero lines.
///
/// **The convention is `file_read`'s, deliberately**: a trailing separator ends
/// the last line, it does not start another — `"a\nb\n"` is 2 lines. This
/// counter used to say 3 (`separators + 1` unconditionally), which made this
/// tool disagree with `file_read` and `wc -l` by exactly one on every file
/// ending in a newline — observed live: an agent burned turns investigating
/// whether 436-vs-435 meant its edit had corrupted the file. Two tools, one
/// number.
fn count_lines_in_file(path: &Path) -> std::io::Result<usize> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut separators = 0usize;
    let mut previous_was_cr = false;
    let mut last_byte: u8 = 0;
    let mut saw_any_byte = false;

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        saw_any_byte = true;
        let chunk = &buffer[..read];

        // Scan with `memchr` rather than a byte-at-a-time match: it is the
        // vectorised search ripgrep and tokei use, and line counting is the
        // only per-file work this tool does. Same arithmetic as before, done in
        // three passes over the chunk instead of one branch per byte —
        // CR and LF each end a line, and a CRLF pair ends only one.
        let lf = memchr::memchr_iter(b'\n', chunk).count();
        let cr = memchr::memchr_iter(b'\r', chunk).count();
        let crlf = memchr::memmem::find_iter(chunk, b"\r\n").count();
        separators += lf + cr - crlf;

        // A CRLF split across two reads: the CR closed the previous chunk and
        // the LF opens this one. Both were counted, and the pair is one line.
        if previous_was_cr && chunk.first() == Some(&b'\n') {
            separators -= 1;
        }
        previous_was_cr = chunk.last() == Some(&b'\r');
        last_byte = *chunk.last().expect("chunk is non-empty");
    }

    if !saw_any_byte {
        return Ok(0);
    }
    // A final line without its separator still counts; a trailing separator
    // adds nothing.
    let ends_terminated = last_byte == b'\n' || last_byte == b'\r';
    Ok(if ends_terminated {
        separators
    } else {
        separators + 1
    })
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/// Workspace-relative and forward-slashed, matching `glob` / `grep` so any of
/// the three can hand a path straight to `file_read`. Falls back to the
/// absolute path if the node somehow sits outside the base, rather than
/// emitting something unusable.
fn relative_path(path: &str, base: &Path) -> String {
    let normalized = path.replace('\\', "/");
    let base_norm = base.to_string_lossy().replace('\\', "/");
    let prefix = format!("{}/", base_norm.trim_end_matches('/'));
    normalized
        .strip_prefix(&prefix)
        .map_or(normalized.clone(), str::to_string)
}

/// Build the nested JSON without recursion.
///
/// The shape is identical to what the tool has always emitted — the agent
/// window's tree card reads `children` / `elided` / `depthLimited` / `lineCount`
/// and must keep getting exactly those. Only the traversal changed.
///
/// It was the last recursive walk in this file: everything else (the directory
/// walk, the budget passes) already uses an explicit stack precisely so a
/// pathological tree cannot exhaust the call stack, and this one was the
/// exception. Depth is capped by the `depth` argument so it was unlikely to
/// overflow in practice, but "unlikely" is what a crash report is made of, and
/// the iterative version costs nothing.
///
/// Two passes over an explicit stack: descend marking each node, then assemble
/// children into parents bottom-up.
fn render_iterative(arena: &Arena, root: usize, base: &Path) -> Value {
    enum Step {
        Enter(usize),
        Assemble(usize),
    }

    let mut stack = vec![Step::Enter(root)];
    // Finished JSON per node index, taken by its parent when it assembles.
    let mut done: std::collections::HashMap<usize, Value> = std::collections::HashMap::new();

    while let Some(step) = stack.pop() {
        match step {
            Step::Enter(idx) => {
                stack.push(Step::Assemble(idx));
                for &child in &arena.nodes[idx].children {
                    if arena.nodes[child].kept {
                        stack.push(Step::Enter(child));
                    }
                }
            }
            Step::Assemble(idx) => {
                let mut payload = render_node(arena, idx, base);
                if arena.nodes[idx].is_dir {
                    let children: Vec<Value> = arena.nodes[idx]
                        .children
                        .iter()
                        .filter(|&&c| arena.nodes[c].kept)
                        .filter_map(|c| done.remove(c))
                        .collect();
                    if !children.is_empty() {
                        payload
                            .as_object_mut()
                            .expect("object literal")
                            .insert("children".into(), Value::Array(children));
                    }
                }
                done.insert(idx, payload);
            }
        }
    }

    done.remove(&root).unwrap_or_else(|| json!({}))
}

/// One node's own fields, without its children.
fn render_node(arena: &Arena, idx: usize, base: &Path) -> Value {
    let node = &arena.nodes[idx];
    let mut payload = json!({
        "name": node.name,
        "path": relative_path(&node.path, base),
        "type": if node.is_dir { "directory" } else { "file" },
    });
    let map = payload.as_object_mut().expect("object literal");

    // `extension` is deliberately not emitted — the name already ends in it,
    // and at ~20 bytes a node it was pure duplication against the budget.
    if let Some(lines) = node.line_count {
        map.insert("lineCount".into(), json!(lines));
    } else if let Some(size) = node.size {
        // Only worth the bytes when there is no line count to give: that is
        // exactly the "too big to count" case the model needs warning about.
        map.insert("size".into(), json!(size));
    }
    // Emitted only when true. `largeFile: false` on every ordinary file was
    // ~20 bytes each to say "nothing to see here".
    if node.large_file == Some(true) {
        map.insert("largeFile".into(), json!(true));
    }
    if let Some(ref err) = node.stat_error {
        map.insert("statError".into(), json!(err));
    }
    if node.is_artifact {
        // A build/dependency dir we intentionally did NOT walk.
        map.insert("artifact".into(), json!(true));
    }
    if node.is_hidden_unwalked {
        // Listed so it is discoverable, not walked.
        map.insert("hidden".into(), json!(true));
    }
    if node.is_dir {
        if node.is_depth_limited {
            // The difference between "nothing here" and "we stopped looking".
            map.insert("depthLimited".into(), json!(true));
        }
        if node.elided > 0 {
            map.insert("elided".into(), json!(node.elided));
        }
        // `children` is attached by `render_iterative`, and an empty array is
        // omitted rather than emitted: at ~15 bytes on every leaf directory it
        // was one of the larger costs in the payload, and it said nothing — the
        // markers above already explain any directory that was not walked, and
        // a directory with neither is genuinely empty.
    }
    payload
}

#[cfg(test)]
mod byte_budget {
    use super::*;
    use crate::agent_runtime::tool_executor::{ToolContext, ToolExecutor};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(workspace: std::path::PathBuf) -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: Some(workspace),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// The lesson this encodes (lesson.md, 2026-08-10): a node budget is not a
    /// byte budget. Long nested paths blow through the ~98-bytes-per-node
    /// estimate, and a call that fit its node count still shipped 221 KB once.
    /// Now the real size is measured and the quota tightened until it fits.
    #[tokio::test]
    async fn a_wide_tree_of_long_names_is_capped_by_bytes_not_node_count() {
        let tmp = tempfile::tempdir().unwrap();
        // Names long enough that a few hundred nodes exceed the cap on their own.
        let long = "a_very_long_directory_name_that_eats_the_byte_budget".repeat(3);
        for d in 0..40 {
            let dir = tmp.path().join(format!("{long}_{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..40 {
                std::fs::write(dir.join(format!("{long}_{f}.ts")), "x\n").unwrap();
            }
        }

        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(
                serde_json::json!({ "depth": 3, "max_nodes": 20_000 }),
                &ctx_for(tmp.path().to_path_buf()),
            )
            .await
            .expect("ok");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        let tree_bytes = serde_json::to_string(&parsed["tree"]).unwrap().len();
        assert!(
            tree_bytes <= MAX_TREE_BYTES,
            "tree was {tree_bytes} bytes, over the {MAX_TREE_BYTES} cap"
        );
        assert_eq!(
            parsed["success"], true,
            "it must still return a usable tree"
        );
        assert!(
            !parsed["tree"].as_array().unwrap().is_empty(),
            "capping must trim, never empty the result"
        );
    }
}

#[cfg(test)]
mod repro {
    use super::*;
    use crate::agent_runtime::tool_executor::{ToolContext, ToolExecutor};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    /// Reproduction for the 2026-08-17 stack overflow: seven concurrent
    /// `workspace_tree` calls with `include_file_stats: true` over a pnpm
    /// monorepo, which is the exact batch the agent issued when the process
    /// died with `0xC00000FD`.
    ///
    /// Ignored because it needs a checkout that is not part of this repo. Run
    /// with the path in `AURORA_REPRO_ROOT`:
    /// `cargo test --lib repro -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "needs AURORA_REPRO_ROOT pointing at a large pnpm monorepo"]
    async fn seven_concurrent_trees_with_file_stats() {
        let Ok(root) = std::env::var("AURORA_REPRO_ROOT") else {
            panic!("set AURORA_REPRO_ROOT to the monorepo checkout");
        };
        let root = std::path::PathBuf::from(root);
        assert!(root.is_dir(), "{} is not a directory", root.display());

        let calls = [
            ("apps", 4, 500),
            ("packages/boot", 4, 500),
            ("packages/api", 4, 500),
            ("packages/host", 4, 500),
            ("packages/client", 3, 700),
            ("python", 4, 300),
            ("packages/sdk", 4, 300),
        ];

        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let outcomes = futures_util::future::join_all(calls.iter().map(|(path, depth, max)| {
            let tool = tool.clone();
            let ctx = ToolContext {
                workspace_access: Default::default(),
                turn_id: "repro".into(),
                tool_call_id: (*path).into(),
                thread_id: "repro".into(),
                workspace_root: Some(root.clone()),
                cancel_token: CancellationToken::new(),
                spill_dir: None,
            };
            async move {
                tool.execute(
                    serde_json::json!({
                        "path": path,
                        "depth": depth,
                        "include_hidden": false,
                        "include_file_stats": true,
                        "max_nodes": max,
                    }),
                    &ctx,
                )
                .await
            }
        }))
        .await;

        for (call, outcome) in calls.iter().zip(&outcomes) {
            println!(
                "{}: {}",
                call.0,
                match outcome {
                    Ok(body) => format!("ok, {} bytes", body.len()),
                    Err(e) => format!("ERR {e}"),
                }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(workspace: Option<std::path::PathBuf>) -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    async fn run(input: Value, root: &Path) -> Value {
        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(input, &ctx_for(Some(root.to_path_buf())))
            .await
            .expect("ok");
        serde_json::from_str(&out).unwrap()
    }

    fn names(tree: &Value) -> Vec<&str> {
        tree.as_array()
            .unwrap()
            .iter()
            .map(|n| n["name"].as_str().unwrap())
            .collect()
    }

    fn count_nodes(tree: &Value) -> usize {
        tree.as_array()
            .unwrap()
            .iter()
            .map(|n| 1 + n.get("children").map_or(0, count_nodes))
            .sum()
    }

    #[tokio::test]
    async fn lists_root_with_default_depth() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b/c")).unwrap();
        std::fs::write(tmp.path().join("a/b/c/leaf.txt"), "x\ny\n").unwrap();
        std::fs::write(tmp.path().join("top.txt"), "1\n").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        assert_eq!(parsed["success"], true);
        let names = names(&parsed["tree"]);
        assert!(names.contains(&"top.txt"));
        assert!(names.contains(&"a"));
    }

    #[tokio::test]
    async fn respects_depth_zero() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b")).unwrap();
        std::fs::write(tmp.path().join("a/b/leaf.txt"), "x").unwrap();
        let parsed = run(json!({ "depth": 0 }), tmp.path()).await;
        assert!(parsed["tree"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shows_artifact_dir_name_but_never_walks_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("build/assets/chunks")).unwrap();
        std::fs::write(tmp.path().join("build/index.html"), "<html>").unwrap();
        std::fs::write(tmp.path().join("main.rs"), "fn main() {}\n").unwrap();

        // Even with a generous depth, build/ must not be walked.
        let parsed = run(json!({ "depth": 5 }), tmp.path()).await;
        let tree = parsed["tree"].as_array().unwrap();

        let build = tree
            .iter()
            .find(|n| n["name"] == "build")
            .expect("build/ should appear as a name-only node");
        assert_eq!(build["artifact"], true);
        assert!(
            build.get("children").is_none(),
            "an unwalked directory carries its marker, not an empty array"
        );
        assert!(tree.iter().any(|n| n["name"] == "main.rs"));
    }

    #[tokio::test]
    async fn lists_top_level_dot_entries_without_walking_them() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".knowledge")).unwrap();
        std::fs::write(tmp.path().join(".knowledge/knowledge.md"), "notes").unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "node_modules\n").unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/.secret"), "x").unwrap();
        std::fs::write(tmp.path().join("src/app.ts"), "y").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        let tree = parsed["tree"].as_array().unwrap();
        let names = names(&parsed["tree"]);

        assert!(names.contains(&".knowledge"), "got: {names:?}");
        assert!(names.contains(&".gitignore"), "top-level dotfiles show too");

        let knowledge = tree.iter().find(|n| n["name"] == ".knowledge").unwrap();
        assert_eq!(knowledge["hidden"], true);
        assert!(knowledge.get("children").is_none());

        let src = tree.iter().find(|n| n["name"] == "src").unwrap();
        let src_names: Vec<&str> = src["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["name"].as_str().unwrap())
            .collect();
        assert!(src_names.contains(&"app.ts"));
        assert!(
            !src_names.contains(&".secret"),
            "nested dotfiles stay hidden"
        );
    }

    #[tokio::test]
    async fn include_hidden_walks_dot_directories() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".knowledge")).unwrap();
        std::fs::write(tmp.path().join(".knowledge/lesson.md"), "notes").unwrap();

        let parsed = run(json!({ "include_hidden": true }), tmp.path()).await;
        let knowledge = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == ".knowledge")
            .expect(".knowledge listed")
            .clone();
        let children: Vec<&str> = knowledge["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["name"].as_str().unwrap())
            .collect();
        assert!(children.contains(&"lesson.md"));
    }

    // ── the regression this rebuild exists for ───────────────────────────

    /// The exact failure measured on Aurora's own repo: a budget squeeze must
    /// never make a top-level directory disappear. The old global "halve the
    /// largest array" pass deleted `src/` outright.
    #[tokio::test]
    async fn a_tight_budget_never_drops_a_top_level_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // One huge directory that would dominate any global trim, plus the
        // small source dir that must survive it.
        std::fs::create_dir_all(tmp.path().join("aaa_huge")).unwrap();
        for i in 0..400 {
            std::fs::write(tmp.path().join(format!("aaa_huge/f{i}.txt")), "x").unwrap();
        }
        std::fs::create_dir_all(tmp.path().join("zzz_src")).unwrap();
        std::fs::write(tmp.path().join("zzz_src/main.rs"), "fn main() {}\n").unwrap();

        let parsed = run(json!({ "max_nodes": 60 }), tmp.path()).await;
        let names = names(&parsed["tree"]);
        assert!(
            names.contains(&"zzz_src"),
            "the small source dir must survive a budget squeeze: {names:?}"
        );

        let huge = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "aaa_huge")
            .unwrap()
            .clone();
        assert!(
            huge["elided"].as_u64().unwrap() > 0,
            "the trimmed directory must report its own omission"
        );
        assert_eq!(parsed["truncated"], true);
        assert!(parsed["note"].as_str().unwrap().contains("elided"));
    }

    #[tokio::test]
    async fn stays_within_the_node_budget() {
        let tmp = tempfile::tempdir().unwrap();
        for d in 0..12 {
            let dir = tmp.path().join(format!("d{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..40 {
                std::fs::write(dir.join(format!("f{f}.txt")), "x").unwrap();
            }
        }
        let parsed = run(json!({ "max_nodes": 100 }), tmp.path()).await;
        let total = count_nodes(&parsed["tree"]);
        assert!(total <= 100, "budget exceeded: {total}");
        assert_eq!(
            parsed["stats"]["nodesReturned"].as_u64().unwrap() as usize,
            total
        );
    }

    /// A small tree must come back whole — no `elided`, no `truncated` — so the
    /// common case is not paying for the pathological one.
    #[tokio::test]
    async fn a_small_tree_is_returned_untrimmed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(tmp.path().join("src/b.rs"), "fn b() {}\n").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        assert!(parsed.get("truncated").is_none());
        let src = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "src")
            .unwrap()
            .clone();
        assert!(src.get("elided").is_none());
        assert_eq!(src["children"].as_array().unwrap().len(), 2);
    }

    /// `children: []` is ambiguous unless something says why. A directory that
    /// exists below the depth limit must be marked, not silently flattened.
    #[tokio::test]
    async fn depth_limited_directories_say_so() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b")).unwrap();
        std::fs::write(tmp.path().join("a/b/deep.txt"), "x").unwrap();

        let parsed = run(json!({ "depth": 2 }), tmp.path()).await;
        let a = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "a")
            .unwrap()
            .clone();
        let b = a["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "b")
            .unwrap()
            .clone();
        assert_eq!(b["depthLimited"], true, "b/ was not walked — say so");
        assert!(b.get("children").is_none());
    }

    #[tokio::test]
    async fn file_stats_come_from_metadata_and_a_streamed_count() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("crlf.txt"), "a\r\nb\r\nc").unwrap();
        std::fs::write(tmp.path().join("empty.txt"), "").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        let tree = parsed["tree"].as_array().unwrap();

        let crlf = tree.iter().find(|n| n["name"] == "crlf.txt").unwrap();
        assert_eq!(crlf["lineCount"], 3, "CRLF pairs count once");

        let empty = tree.iter().find(|n| n["name"] == "empty.txt").unwrap();
        assert_eq!(empty["lineCount"], 0);
    }

    /// Payload terseness is a budget constraint, not a cosmetic one — 1,200
    /// nodes of the old shape came to 221 KB. `size` and `largeFile` earn their
    /// bytes only when they say something a `lineCount` does not.
    #[tokio::test]
    async fn countable_files_omit_size_and_extension() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("small.rs"), "fn a() {}\n").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        let node = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "small.rs")
            .unwrap()
            .clone();

        // One line — the trailing newline terminates it, same convention as
        // `file_read` and `wc -l`.
        assert_eq!(node["lineCount"], 1);
        assert!(node.get("size").is_none(), "lineCount already covers it");
        assert!(node.get("extension").is_none(), "the name ends in .rs");
        assert!(
            node.get("largeFile").is_none(),
            "only emitted when actually large"
        );
    }

    /// Paths must be workspace-relative and forward-slashed so they match what
    /// `glob` and `grep` return and can be passed straight to `file_read`.
    #[tokio::test]
    async fn paths_are_workspace_relative_and_forward_slashed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/api")).unwrap();
        std::fs::write(tmp.path().join("src/api/mod.rs"), "x\n").unwrap();

        let parsed = run(json!({}), tmp.path()).await;
        let api = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "src")
            .unwrap()["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "api")
            .unwrap()
            .clone();
        let file = api["children"].as_array().unwrap()[0].clone();

        assert_eq!(file["path"], "src/api/mod.rs");
        // rootPath stays absolute so the relative paths can be reconstructed.
        assert!(parsed["rootPath"].as_str().unwrap().len() > "src/api".len());
    }

    #[tokio::test]
    async fn stats_can_be_switched_off() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x\ny\n").unwrap();
        let parsed = run(json!({ "include_file_stats": false }), tmp.path()).await;
        let a = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["name"] == "a.txt")
            .unwrap()
            .clone();
        assert!(a.get("lineCount").is_none());
        assert!(a.get("size").is_none());
    }

    #[tokio::test]
    async fn missing_directory_returns_actionable_guidance() {
        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let err = tool
            .execute(
                json!({ "path": "nope" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect_err("must fail");
        let message = format!("{err}");
        assert!(message.contains("workspace_tree"), "{message}");
    }

    // ── unit tests for the budget maths ──────────────────────────────────

    fn leaf(name: &str) -> Node {
        Node {
            name: name.into(),
            path: name.into(),
            is_dir: false,
            extension: None,
            is_artifact: false,
            is_hidden_unwalked: false,
            is_depth_limited: false,
            children: Vec::new(),
            kept: true,
            elided: 0,
            size: None,
            line_count: None,
            large_file: None,
            stat_error: None,
        }
    }

    #[test]
    fn quota_search_is_monotonic_and_fits() {
        // One root directory holding 100 files.
        let mut nodes: Vec<Node> = Vec::new();
        let mut dir = leaf("dir");
        dir.is_dir = true;
        nodes.push(dir);
        for i in 0..100 {
            nodes.push(leaf(&format!("f{i}")));
            let idx = nodes.len() - 1;
            nodes[0].children.push(idx);
        }
        let arena = Arena {
            nodes,
            roots: vec![0],
        };

        // 1 root + q files must be <= budget, so q = 9 for a budget of 10.
        let quota = fit_quota(&arena, 10);
        assert_eq!(quota, 9);
        assert!(count_with_quota(&arena, quota) <= 10);
        assert!(count_with_quota(&arena, quota + 1) > 10);
    }

    #[test]
    fn a_tree_inside_budget_needs_no_quota() {
        let arena = Arena {
            nodes: vec![leaf("a"), leaf("b")],
            roots: vec![0, 1],
        };
        assert_eq!(fit_quota(&arena, 10), usize::MAX);
    }

    #[test]
    fn line_counter_matches_file_read_and_wc() {
        // ONE convention across `workspace_tree`, `file_read`, and `wc -l`: a
        // trailing separator ends the last line rather than starting a phantom
        // one. The old `+1` semantics made this tool report 436 for a file
        // every other counter called 435, and an agent spent turns
        // investigating whether its own edit had corrupted the file.
        let tmp = tempfile::tempdir().unwrap();
        for (content, expected) in [
            ("", 0usize),
            ("one line", 1),
            ("a\nb\n", 2),
            ("a\r\nb\r\n", 2),
            ("a\rb\r", 2),
            ("a\nb", 2),
            ("\n", 1),
        ] {
            let path = tmp.path().join("probe.txt");
            std::fs::write(&path, content).unwrap();
            assert_eq!(
                count_lines_in_file(&path).unwrap(),
                expected,
                "content {content:?}"
            );
        }
    }

    #[test]
    fn line_counter_handles_a_crlf_split_across_buffers() {
        // Force a CR at the very end of a 64 KiB read so the pair straddles
        // two buffers — the case a naive per-chunk counter gets wrong.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("split.txt");
        let mut content = vec![b'x'; 64 * 1024 - 1];
        content.push(b'\r');
        content.push(b'\n');
        content.push(b'y');
        std::fs::write(&path, &content).unwrap();
        assert_eq!(count_lines_in_file(&path).unwrap(), 2);
    }
}
