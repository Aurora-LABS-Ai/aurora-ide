//! `workspace_tree` — bounded recursive directory listing.
//!
//! Mirrors the TS `workspaceTreeExecutor`. Walks the resolved
//! root with a manual stack (no async recursion) up to a
//! configurable depth, optionally collecting `lineCount` / `size`
//! / `largeFile` metadata for the first N files. The traversal
//! reuses `crate::commands::read_directory` so we inherit the
//! same exclusion rules (.git, node_modules, target, etc.).

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::{read_directory, FileEntry};

/// `LARGE_FILE_LINE_THRESHOLD` from `file-read-policy.ts`.
const LARGE_FILE_LINE_THRESHOLD: usize = 1_500;
const DEFAULT_DEPTH: i64 = 3;
const DEFAULT_MAX_FILES_FOR_STATS: usize = 300;

/// Directory names that hold build output, dependencies, or caches. The tree
/// shows the folder *name* (so the model knows it exists) but NEVER descends
/// into it — at ANY depth. Their contents are artifacts, not source, and would
/// otherwise flood the result (a depth-3 walk into `build/` or `node_modules/`
/// dumps thousands of generated files). Compared case-insensitively.
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

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "workspace_tree".into(),
            description: "Get the directory tree structure of the workspace or a specific \
                          subdirectory. Defaults to depth=3. File nodes include lineCount, size, \
                          and largeFile metadata for the first 300 files (configurable). Use \
                          before file_read so large files can be inspected with start_line/end_line."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path. Defaults to workspace root." },
                    "depth": { "type": "number", "default": 3, "description": "Maximum traversal depth. -1 for unlimited." },
                    "include_hidden": { "type": "boolean", "default": false },
                    "include_file_stats": { "type": "boolean", "default": true },
                    "max_files_for_stats": { "type": "number", "default": 300 }
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
        let max_files_for_stats = input
            .get("max_files_for_stats")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_MAX_FILES_FOR_STATS);

        let target = match (raw_path, ctx.workspace_root.as_deref()) {
            // Use the tolerant read-resolver: a path that doesn't exist yet
            // resolves to its in-workspace location instead of hard-failing at
            // canonicalization with a cryptic `os error 2`. The existence check
            // below then turns a missing directory into a clear, recoverable
            // message rather than a raw OS error.
            (Some(p), Some(root)) if p != "." => {
                super::resolve_path_for_read(p, Some(root), ctx.allow_outside_workspace)?
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

        let mut stats_read = 0usize;
        let mut stats_skipped = 0usize;
        let tree = build_tree(
            &target,
            depth,
            include_hidden,
            include_file_stats,
            max_files_for_stats,
            &mut stats_read,
            &mut stats_skipped,
        )
        .await
        .map_err(ToolError::Execution)?;

        Ok(serde_json::to_string(&json!({
            "success": true,
            "rootPath": target.to_string_lossy(),
            "depth": depth,
            "stats": {
                "included": include_file_stats,
                "filesRead": stats_read,
                "filesSkipped": stats_skipped,
                "maxFilesForStats": max_files_for_stats,
            },
            "tree": tree,
        }))
        .unwrap())
    }
}

/// Manual-stack BFS-ish traversal: a worklist of `(path, depth,
/// parent_index)` lets us push child nodes into their parent's
/// `children` array without recursion. Uses a `Vec<NodeSlot>`
/// arena so node references stay stable.
async fn build_tree(
    root: &Path,
    max_depth: i64,
    include_hidden: bool,
    include_file_stats: bool,
    max_files_for_stats: usize,
    stats_read: &mut usize,
    stats_skipped: &mut usize,
) -> Result<Vec<Value>, String> {
    use std::collections::VecDeque;

    /// A node we've allocated but might still need to push children
    /// into.
    struct NodeSlot {
        name: String,
        path: String,
        is_dir: bool,
        extension: Option<String>,
        line_count: Option<usize>,
        size: Option<usize>,
        large_file: Option<bool>,
        stat_error: Option<String>,
        is_artifact: bool,
        children: Vec<usize>,
    }

    let mut arena: Vec<NodeSlot> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut work: VecDeque<(PathBuf, i64, Option<usize>)> = VecDeque::new();

    // Seed with the root's children at depth 0.
    work.push_back((root.to_path_buf(), 0, None));

    while let Some((dir, current_depth, parent_idx)) = work.pop_front() {
        if max_depth != -1 && current_depth >= max_depth {
            continue;
        }
        let entries: Vec<FileEntry> = read_directory(dir.to_string_lossy().to_string(), Some(true))
            .await
            .map_err(|e| format!("read_directory failed for {}: {}", dir.display(), e))?;

        for entry in entries {
            if !include_hidden && entry.name.starts_with('.') {
                continue;
            }
            let mut slot = NodeSlot {
                name: entry.name.clone(),
                path: entry.path.clone(),
                is_dir: entry.is_dir,
                extension: if entry.is_file {
                    entry.extension.clone()
                } else {
                    None
                },
                line_count: None,
                size: None,
                large_file: None,
                stat_error: None,
                is_artifact: entry.is_dir && is_artifact_dir(&entry.name),
                children: Vec::new(),
            };

            if entry.is_file && include_file_stats {
                if *stats_read >= max_files_for_stats {
                    *stats_skipped += 1;
                } else {
                    let path_for_stat = entry.path.clone();
                    let read = tokio::task::spawn_blocking(move || {
                        crate::file_cache::read_file_cached(&path_for_stat)
                    })
                    .await
                    .map_err(|e| format!("stat task panicked: {e}"))?;
                    match read {
                        Ok(content) => {
                            let lines = count_lines(&content);
                            slot.line_count = Some(lines);
                            slot.size = Some(content.len());
                            slot.large_file = Some(lines > LARGE_FILE_LINE_THRESHOLD);
                            *stats_read += 1;
                        }
                        Err(err) => {
                            slot.stat_error = Some(err);
                        }
                    }
                }
            }

            arena.push(slot);
            let idx = arena.len() - 1;
            match parent_idx {
                Some(p) => arena[p].children.push(idx),
                None => roots.push(idx),
            }

            // Descend into real directories only. Artifact / dependency dirs
            // stay in the tree as a NAME-ONLY node (no children) and are never
            // walked, so `build/`, `out/`, `node_modules/`, etc. can't flood the
            // result no matter how deep `depth` is set.
            if entry.is_dir && !is_artifact_dir(&entry.name) {
                work.push_back((PathBuf::from(&entry.path), current_depth + 1, Some(idx)));
            }
        }
    }

    fn render(arena: &[NodeSlot], idx: usize) -> Value {
        let node = &arena[idx];
        let mut payload = json!({
            "name": node.name,
            "path": node.path,
            "type": if node.is_dir { "directory" } else { "file" },
        });
        let map = payload.as_object_mut().unwrap();
        if let Some(ref ext) = node.extension {
            map.insert("extension".into(), json!(ext));
        }
        if let Some(lc) = node.line_count {
            map.insert("lineCount".into(), json!(lc));
        }
        if let Some(sz) = node.size {
            map.insert("size".into(), json!(sz));
        }
        if let Some(lf) = node.large_file {
            map.insert("largeFile".into(), json!(lf));
        }
        if let Some(ref err) = node.stat_error {
            map.insert("statError".into(), json!(err));
        }
        if node.is_artifact {
            // Marks a build/dependency dir we intentionally did NOT walk. The
            // node carries the name only; `children` is empty by construction.
            map.insert("artifact".into(), json!(true));
        }
        if node.is_dir {
            let children: Vec<Value> = node.children.iter().map(|&c| render(arena, c)).collect();
            map.insert("children".into(), json!(children));
        }
        payload
    }

    Ok(roots.iter().map(|&r| render(&arena, r)).collect())
}

fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    let bytes = content.as_bytes();
    let mut separators = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                separators += 1;
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            b'\n' => {
                separators += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    separators + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(workspace: Option<std::path::PathBuf>) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn lists_root_with_default_depth() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b/c")).unwrap();
        std::fs::write(tmp.path().join("a/b/c/leaf.txt"), "x\ny\n").unwrap();
        std::fs::write(tmp.path().join("top.txt"), "1\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(
                serde_json::json!({}),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], true);
        let tree = parsed["tree"].as_array().unwrap();
        let names: Vec<&str> = tree.iter().map(|n| n["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"top.txt"));
        assert!(names.contains(&"a"));
    }

    #[tokio::test]
    async fn respects_depth_zero() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b")).unwrap();
        std::fs::write(tmp.path().join("a/b/leaf.txt"), "x").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(
                serde_json::json!({ "depth": 0 }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert!(parsed["tree"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shows_artifact_dir_name_but_never_walks_it() {
        let tmp = tempfile::tempdir().unwrap();
        // A build/ tree several levels deep, plus a real source file.
        std::fs::create_dir_all(tmp.path().join("build/assets/chunks")).unwrap();
        std::fs::write(tmp.path().join("build/index.html"), "<html>").unwrap();
        std::fs::write(tmp.path().join("build/assets/chunks/app.js"), "x").unwrap();
        std::fs::write(tmp.path().join("main.rs"), "fn main() {}\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(
                // Even with a generous depth, build/ must not be walked.
                serde_json::json!({ "depth": 5 }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let tree = parsed["tree"].as_array().unwrap();

        let build = tree
            .iter()
            .find(|n| n["name"] == "build")
            .expect("build/ should appear as a name-only node");
        assert_eq!(build["type"], "directory");
        assert_eq!(build["artifact"], true);
        assert!(
            build["children"].as_array().unwrap().is_empty(),
            "artifact dir must have no children"
        );
        // The real source file is still listed.
        assert!(tree.iter().any(|n| n["name"] == "main.rs"));
    }

    #[tokio::test]
    async fn skips_hidden_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".hidden"), "x").unwrap();
        std::fs::write(tmp.path().join("visible.txt"), "y").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(WorkspaceTreeTool);
        let out = tool
            .execute(
                serde_json::json!({}),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let names: Vec<String> = parsed["tree"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"visible.txt".to_string()));
        assert!(!names.contains(&".hidden".to_string()));
    }
}
