//! `multi_file_read` — parallel file reads with size budgets. Wraps
//! `crate::commands::read_files_batch` and applies the same
//! per-file and total-size guard rails as the TS executor.

use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::read_files_batch;

/// Mirrors `MAX_FILES` in `src/tools/executors/file-executors-enhanced.ts`.
const MAX_FILES: usize = 20;
/// `MAX_FILE_SIZE` from the TS executor (500 KB single-file cap).
const MAX_FILE_SIZE: usize = 500 * 1024;
/// `MAX_MULTI_FILE_TOTAL_SIZE` from the TS executor (2 MB total cap).
const MAX_MULTI_FILE_TOTAL_SIZE: usize = 2 * 1024 * 1024;
/// `LARGE_FILE_LINE_THRESHOLD` from `file-read-policy.ts`.
const LARGE_FILE_LINE_THRESHOLD: usize = 1_500;
/// `DEFAULT_LINE_WINDOW` from `file-read-policy.ts`.
const DEFAULT_LINE_WINDOW: usize = 250;

pub struct MultiFileReadTool;

#[async_trait]
impl ToolExecutor for MultiFileReadTool {
    fn name(&self) -> &str {
        "multi_file_read"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "multi_file_read".into(),
            description: "Read multiple small/medium files in parallel. Files >1500 lines or \
                          >500KB are returned with largeFile=true and a hint to switch to \
                          file_read with start_line/end_line."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "File paths to read in parallel."
                    }
                },
                "required": ["paths"],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let arr = input.get("paths").and_then(Value::as_array).ok_or_else(|| {
            ToolError::InvalidInput("`paths` must be an array of strings".into())
        })?;
        if arr.is_empty() {
            return Err(ToolError::InvalidInput(
                "`paths` must be a non-empty array".into(),
            ));
        }
        if arr.len() > MAX_FILES {
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "error": format!(
                    "Too many files requested ({}). Maximum is {MAX_FILES} per request to prevent context overflow.",
                    arr.len()
                ),
            }))
            .unwrap());
        }

        // Path safety pass.
        struct Resolved {
            input_path: String,
            full_path: String,
        }
        let mut resolved = Vec::with_capacity(arr.len());
        for entry in arr {
            let path = entry.as_str().ok_or_else(|| {
                ToolError::InvalidInput("each entry of `paths` must be a string".into())
            })?;
            let abs = super::resolve_path(path, ctx.workspace_root.as_deref())?;
            resolved.push(Resolved {
                input_path: path.to_string(),
                full_path: abs.to_string_lossy().to_string(),
            });
        }

        let started = Instant::now();
        let read_paths: Vec<String> = resolved.iter().map(|r| r.full_path.clone()).collect();
        let map = read_files_batch(read_paths.clone()).await;

        let mut files: Vec<Value> = Vec::with_capacity(resolved.len());
        let mut total_content_size = 0usize;
        let mut content_limit_reached = false;
        let mut success_count = 0usize;
        let mut error_count = 0usize;

        for entry in resolved {
            let result = map.get(&entry.full_path);
            match result {
                Some(Ok(content)) => {
                    let lines = count_lines(content);
                    let size = content.len();
                    let large = lines > LARGE_FILE_LINE_THRESHOLD || size > MAX_FILE_SIZE;
                    if large {
                        success_count += 1;
                        files.push(json!({
                            "path": entry.input_path,
                            "success": true,
                            "content": "",
                            "lines": lines,
                            "size": size,
                            "largeFile": true,
                            "requiresLineRange": true,
                            "warning": format!(
                                "File is too large for multi_file_read ({lines} lines, {size} bytes). Use file_read with start_line/end_line.",
                            ),
                            "suggestedRange": {
                                "startLine": 1,
                                "endLine": std::cmp::min(DEFAULT_LINE_WINDOW, lines.max(1)),
                            }
                        }));
                        continue;
                    }

                    let content_size = size;
                    if total_content_size + content_size > MAX_MULTI_FILE_TOTAL_SIZE {
                        if !content_limit_reached {
                            content_limit_reached = true;
                            let remaining =
                                MAX_MULTI_FILE_TOTAL_SIZE.saturating_sub(total_content_size);
                            if remaining > 1000 {
                                let truncated = safe_truncate(content, remaining);
                                total_content_size += truncated.len();
                                success_count += 1;
                                files.push(json!({
                                    "path": entry.input_path,
                                    "success": true,
                                    "content": truncated,
                                    "lines": lines,
                                    "truncated": true,
                                }));
                            } else {
                                error_count += 1;
                                files.push(json!({
                                    "path": entry.input_path,
                                    "success": false,
                                    "error": "Content limit reached. File skipped to prevent context overflow.",
                                }));
                            }
                        } else {
                            error_count += 1;
                            files.push(json!({
                                "path": entry.input_path,
                                "success": false,
                                "error": "Content limit reached. File skipped to prevent context overflow.",
                            }));
                        }
                    } else {
                        total_content_size += content_size;
                        success_count += 1;
                        files.push(json!({
                            "path": entry.input_path,
                            "success": true,
                            "content": content,
                            "lines": lines,
                        }));
                    }
                }
                Some(Err(err)) => {
                    error_count += 1;
                    files.push(json!({
                        "path": entry.input_path,
                        "success": false,
                        "error": err,
                    }));
                }
                None => {
                    error_count += 1;
                    files.push(json!({
                        "path": entry.input_path,
                        "success": false,
                        "error": format!("Failed to read {}", entry.full_path),
                    }));
                }
            }
        }

        let total_time = started.elapsed().as_millis() as u64;
        let total_files = arr.len();
        let avg = if total_files > 0 {
            total_time / total_files as u64
        } else {
            0
        };

        let mut payload = json!({
            "success": true,
            "filesRead": success_count,
            "filesError": error_count,
            "totalFiles": total_files,
            "totalContentSize": total_content_size,
            "contentLimitReached": content_limit_reached,
            "totalTime": total_time,
            "averageTimePerFile": avg,
            "files": files,
        });
        if content_limit_reached {
            payload["warning"] = json!(format!(
                "Content limit ({}MB) reached. Some files were truncated or skipped.",
                MAX_MULTI_FILE_TOTAL_SIZE / 1024 / 1024
            ));
        }

        // Remove `path` resolution helper crumbs (e.g. avoid touching
        // the disk twice for stat) — the response shape is final.
        let _ = Path::new("");
        Ok(serde_json::to_string(&payload).unwrap())
    }
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

/// Truncate to the largest UTF-8 prefix at most `max_bytes` long.
fn safe_truncate(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
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
    async fn reads_two_small_files_in_parallel() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "beta").unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": ["a.txt", "b.txt"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filesRead"], 2);
        assert_eq!(parsed["filesError"], 0);
        let files = parsed["files"].as_array().unwrap();
        let a = files.iter().find(|f| f["path"] == "a.txt").unwrap();
        let b = files.iter().find(|f| f["path"] == "b.txt").unwrap();
        assert_eq!(a["content"], "alpha");
        assert_eq!(b["content"], "beta");
    }

    #[tokio::test]
    async fn rejects_too_many_paths() {
        let paths: Vec<String> = (0..30).map(|i| format!("f{i}.txt")).collect();
        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": paths }),
                &ctx_for(None),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("Too many"));
    }
}
