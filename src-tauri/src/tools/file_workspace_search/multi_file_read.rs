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

/// The line range to read from EVERY file of a batch.
///
/// Set when `file_read` was called with `paths` plus `start_line`/`end_line`/
/// `max_lines`. One range shared by all files is the only thing that request can
/// mean, and it is how a model compares the same region across implementations.
#[derive(Clone, Copy)]
struct Window {
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
}

impl Window {
    /// Read the window off a call's arguments, or `None` when it named no range.
    fn from_input(input: &Value) -> Option<Self> {
        let field = |key: &str| input.get(key).and_then(Value::as_u64).map(|n| n as usize);
        let window = Self {
            start_line: field("start_line"),
            end_line: field("end_line"),
            max_lines: field("max_lines"),
        };
        let named_any =
            window.start_line.is_some() || window.end_line.is_some() || window.max_lines.is_some();
        named_any.then_some(window)
    }
}

pub struct MultiFileReadTool;

#[async_trait]
impl ToolExecutor for MultiFileReadTool {
    fn name(&self) -> &str {
        "multi_file_read"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "multi_file_read".into(),
            description: "Read multiple files in parallel. Without a line range, files >1500 \
                          lines or >500KB come back with largeFile=true instead of content. With \
                          start_line/end_line/max_lines, the same range is read from every file \
                          and the size bail-out does not apply."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "File paths to read in parallel."
                    },
                    "start_line": { "type": "number", "description": "1-based first line to read from every file." },
                    "end_line": { "type": "number", "description": "1-based inclusive last line to read from every file." },
                    "max_lines": { "type": "number", "description": "Maximum lines per file from start_line (hard cap 1000)." }
                },
                "required": ["paths"],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let arr = input
            .get("paths")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::InvalidInput("`paths` must be an array of strings".into()))?;
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
        let mut files: Vec<Value> = Vec::new();
        let mut error_count = 0usize;
        for entry in arr {
            let path = entry.as_str().ok_or_else(|| {
                ToolError::InvalidInput("each entry of `paths` must be a string".into())
            })?;
            let abs = match super::resolve_path_for_read_with_spill(
                path,
                ctx.workspace_root.as_deref(),
                ctx.allow_outside_workspace,
                ctx.spill_dir.as_deref(),
            ) {
                Ok(abs) => abs,
                Err(ToolError::Execution(err)) => {
                    error_count += 1;
                    files.push(json!({
                        "path": path,
                        "success": false,
                        "error": format!("Invalid file path: {err}"),
                    }));
                    continue;
                }
                Err(err) => return Err(err),
            };
            resolved.push(Resolved {
                input_path: path.to_string(),
                full_path: abs.to_string_lossy().to_string(),
            });
        }

        let window = Window::from_input(&input);

        let started = Instant::now();
        let read_paths: Vec<String> = resolved.iter().map(|r| r.full_path.clone()).collect();
        let map = read_files_batch(read_paths.clone()).await;

        let mut total_content_size = 0usize;
        let mut content_limit_reached = false;
        let mut success_count = 0usize;

        for entry in resolved {
            let result = map.get(&entry.full_path);
            match result {
                Some(Ok(content)) => {
                    let lines = count_lines(content);
                    let size = content.len();

                    // A window names a slice, so being large is not grounds to
                    // refuse a file here — reading part of a big file is exactly
                    // what the caller asked for, and the `largeFile` bail-out
                    // below would reject the request made to avoid the problem it
                    // reports. Slicing goes through `file_read::slice_window`, so
                    // a windowed batch and a windowed single read cut by the same
                    // rules and share the 1000-line-per-file cap.
                    let (body, extras) = match window {
                        Some(window) => {
                            let (text, start, end, before, after, truncated, capped) =
                                super::file_read::slice_window(
                                    content,
                                    lines,
                                    window.start_line,
                                    window.end_line,
                                    window.max_lines,
                                );
                            let mut extras = serde_json::Map::new();
                            extras.insert(
                                "range".into(),
                                json!({ "startLine": start, "endLine": end }),
                            );
                            extras.insert("windowed".into(), json!(true));
                            extras.insert("cappedAtMaxLines".into(), json!(capped));
                            extras.insert("omittedLinesBefore".into(), json!(before));
                            extras.insert("omittedLinesAfter".into(), json!(after));
                            extras.insert("truncated".into(), json!(truncated));
                            if capped {
                                extras.insert(
                                    "warning".into(),
                                    json!(format!(
                                        "Capped at {} lines: returned {start}-{end} of {lines}. Continue this file from start_line: {}.",
                                        super::file_read::MAX_SINGLE_READ_LINES,
                                        end.saturating_add(1)
                                    )),
                                );
                            }
                            (text, extras)
                        }
                        None => {
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
                                        "File is too large to return whole ({lines} lines, {size} bytes). Re-read it with start_line/end_line — a range works with `paths` too, and is applied to every file.",
                                    ),
                                    "suggestedRange": {
                                        "startLine": 1,
                                        "endLine": std::cmp::min(DEFAULT_LINE_WINDOW, lines.max(1)),
                                    }
                                }));
                                continue;
                            }
                            (content.clone(), serde_json::Map::new())
                        }
                    };

                    // The budget is spent on what is actually returned, so a
                    // window that trims a 5000-line file to 300 lines leaves the
                    // rest of the batch its room.
                    let content = &body;
                    let content_size = body.len();
                    if total_content_size + content_size > MAX_MULTI_FILE_TOTAL_SIZE {
                        if !content_limit_reached {
                            content_limit_reached = true;
                            let remaining =
                                MAX_MULTI_FILE_TOTAL_SIZE.saturating_sub(total_content_size);
                            if remaining > 1000 {
                                let truncated = safe_truncate(content, remaining);
                                total_content_size += truncated.len();
                                success_count += 1;
                                files.push(with_extras(
                                    json!({
                                        "path": entry.input_path,
                                        "success": true,
                                        "content": truncated,
                                        "lines": lines,
                                        "truncated": true,
                                    }),
                                    &extras,
                                ));
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
                        files.push(with_extras(
                            json!({
                                "path": entry.input_path,
                                "success": true,
                                "content": content,
                                "lines": lines,
                            }),
                            &extras,
                        ));
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

/// Parallel batch read, reused by [`super::file_read`]'s `paths` form so
/// the single `file_read` tool covers both single- and multi-file reads
/// without exposing a second tool name to the model.
pub(crate) async fn read_many(input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
    MultiFileReadTool.execute(input, ctx).await
}

/// Attach the per-file window fields to a success payload.
///
/// The size-budget branches build their own objects, so the extras are merged
/// here rather than threaded through each one. Existing keys win: a byte-budget
/// `truncated: true` describes a cut the window did not make, and must not be
/// overwritten by the window's own answer for the same key.
fn with_extras(mut payload: Value, extras: &serde_json::Map<String, Value>) -> Value {
    if let Some(object) = payload.as_object_mut() {
        for (key, value) in extras {
            object.entry(key.as_str()).or_insert_with(|| value.clone());
        }
    }
    payload
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
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
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

    /// The batch case behind `file_read`'s `paths` + line range form: one range,
    /// read from every file. This used to be rejected outright, which cost a
    /// whole iteration every time a model compared the same region across files.
    #[tokio::test]
    async fn applies_one_window_to_every_file() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=20).map(|n| format!("line{n}\n")).collect();
        std::fs::write(tmp.path().join("a.txt"), &body).unwrap();
        std::fs::write(tmp.path().join("b.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "paths": ["a.txt", "b.txt"],
                    "start_line": 3,
                    "end_line": 5,
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("a windowed batch read is served, not rejected");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filesRead"], 2);
        assert_eq!(parsed["filesError"], 0);
        for name in ["a.txt", "b.txt"] {
            let file = parsed["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"] == name)
                .unwrap();
            assert_eq!(file["content"], "line3\nline4\nline5");
            assert_eq!(file["windowed"], true);
            assert_eq!(file["range"]["startLine"], 3);
            assert_eq!(file["range"]["endLine"], 5);
            assert_eq!(file["omittedLinesBefore"], 2);
        }
    }

    /// A window is how you read part of a big file, so the `largeFile` bail-out
    /// must not fire for one — refusing here would reject the request made to
    /// avoid the very problem the refusal reports.
    #[tokio::test]
    async fn a_window_reads_into_a_file_too_large_to_return_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=(LARGE_FILE_LINE_THRESHOLD + 500))
            .map(|n| format!("line{n}\n"))
            .collect();
        std::fs::write(tmp.path().join("big.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "paths": ["big.txt"],
                    "start_line": 10,
                    "end_line": 12,
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        let file = &parsed["files"][0];
        assert_eq!(file["content"], "line10\nline11\nline12");
        assert!(
            file["largeFile"].is_null(),
            "a windowed read is not a largeFile refusal: {file}"
        );
    }

    /// Asking for more than the per-file cap returns the first slice and says so,
    /// with the exact line to resume from — the same contract as a single read.
    #[tokio::test]
    async fn a_window_wider_than_the_cap_is_capped_per_file() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=1_400).map(|n| format!("line{n}\n")).collect();
        std::fs::write(tmp.path().join("wide.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": ["wide.txt"], "start_line": 1, "end_line": 1_400 }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        let file = &parsed["files"][0];
        assert_eq!(file["cappedAtMaxLines"], true);
        assert_eq!(
            file["range"]["endLine"],
            super::super::file_read::MAX_SINGLE_READ_LINES
        );
        assert!(file["warning"]
            .as_str()
            .unwrap()
            .contains("start_line: 1001"));
    }

    /// No range means the old behaviour, untouched: a large file still reports
    /// itself instead of flooding the batch.
    #[tokio::test]
    async fn without_a_window_a_large_file_still_reports_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=(LARGE_FILE_LINE_THRESHOLD + 10))
            .map(|n| format!("line{n}\n"))
            .collect();
        std::fs::write(tmp.path().join("big.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": ["big.txt"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");

        let parsed: Value = serde_json::from_str(&out).unwrap();
        let file = &parsed["files"][0];
        assert_eq!(file["largeFile"], true);
        assert_eq!(file["content"], "");
    }

    #[tokio::test]
    async fn rejects_too_many_paths() {
        let paths: Vec<String> = (0..30).map(|i| format!("f{i}.txt")).collect();
        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(serde_json::json!({ "paths": paths }), &ctx_for(None))
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("Too many"));
    }

    #[tokio::test]
    async fn reports_missing_file_without_aborting_batch() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(MultiFileReadTool);
        let out = tool
            .execute(
                serde_json::json!({ "paths": ["a.txt", "missing.txt"] }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("missing file should be a per-file error");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filesRead"], 1);
        assert_eq!(parsed["filesError"], 1);
        let files = parsed["files"].as_array().unwrap();
        let missing = files.iter().find(|f| f["path"] == "missing.txt").unwrap();
        assert_eq!(missing["success"], false);
    }
}
