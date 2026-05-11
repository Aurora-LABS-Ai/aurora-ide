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
            (Some(p), Some(root)) if p != "." => super::resolve_path(p, Some(root))?,
            (Some(p), None) => PathBuf::from(p),
            (None, Some(root)) | (Some(_), Some(root)) => root.to_path_buf(),
            (None, None) => {
                return Err(ToolError::InvalidInput(
                    "no `path` provided and no workspace root in context".into(),
                ));
            }
        };

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
                extension: if entry.is_file { entry.extension.clone() } else { None },
                line_count: None,
                size: None,
                large_file: None,
                stat_error: None,
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

            if entry.is_dir {
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
