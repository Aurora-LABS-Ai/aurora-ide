//! `file_read` — bounded line-window read.
//!
//! Wraps `crate::commands::read_file_content` and applies the same
//! line-policy as the TS `fileReadExecutor` (large files return
//! truncated windows; small files return full content). Returns a
//! JSON object matching the TS executor's response shape so the
//! agent's downstream behaviour does not change.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::resolve_path;

/// Chosen to match the TS executor (`MAX_FILE_SIZE = 500 * 1024`).
const MAX_FILE_SIZE: usize = 500 * 1024;
/// `MAX_SINGLE_READ_LINES` from `src/tools/executors/file-read-policy.ts`.
const MAX_SINGLE_READ_LINES: usize = 1_000;
/// `DEFAULT_LINE_WINDOW` from `src/tools/executors/file-read-policy.ts`.
const DEFAULT_LINE_WINDOW: usize = 250;
/// `LARGE_FILE_LINE_THRESHOLD` from the same TS file.
const LARGE_FILE_LINE_THRESHOLD: usize = 1_500;

pub struct FileReadTool;

#[async_trait]
impl ToolExecutor for FileReadTool {
    fn name(&self) -> &str {
        "file_read"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_read".into(),
            description: "Read file content safely. Small files are returned in full; large files \
                          (>1500 lines or >500KB) are returned as a bounded line window. Use \
                          start_line and end_line for precise 1-based inclusive reads."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The full path of the file to read." },
                    "start_line": { "type": "number", "description": "Optional 1-based first line to return." },
                    "end_line": { "type": "number", "description": "Optional 1-based inclusive last line to return." },
                    "max_lines": { "type": "number", "description": "Optional maximum lines to return from start_line." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`path` must be a string".into()))?;

        let resolved = resolve_path(path, ctx.workspace_root.as_deref())?;
        let start_line = input.get("start_line").and_then(Value::as_u64).map(|n| n as usize);
        let end_line = input.get("end_line").and_then(Value::as_u64).map(|n| n as usize);
        let max_lines = input.get("max_lines").and_then(Value::as_u64).map(|n| n as usize);

        let path_owned = resolved.to_string_lossy().to_string();
        let raw_path = path.to_string();

        let body = tokio::task::spawn_blocking(move || read_with_policy(&path_owned, &raw_path, start_line, end_line, max_lines))
            .await
            .map_err(|err| ToolError::Execution(format!("file_read task panicked: {err}")))??;

        Ok(body)
    }
}

fn read_with_policy(
    full_path: &str,
    rel_path: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<String, ToolError> {
    let content = match std::fs::read_to_string(Path::new(full_path)) {
        Ok(c) => c,
        Err(err) => {
            // Mirror TS executor: returns success=false JSON, NOT a thrown error.
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "error": format!("Failed to read file: {err}"),
            }))
            .unwrap());
        }
    };

    let total_lines = count_lines(&content);
    let explicit = start_line.is_some() || end_line.is_some();

    if explicit || total_lines > LARGE_FILE_LINE_THRESHOLD {
        let (sliced, range_start, range_end, omit_before, omit_after, truncated) =
            slice_window(&content, total_lines, start_line, end_line, max_lines);
        let warning = if truncated {
            Some(format!(
                "Returned lines {}-{} of {}. Use start_line/end_line to read another range.",
                range_start, range_end, total_lines
            ))
        } else {
            None
        };
        let payload = json!({
            "success": true,
            "path": rel_path,
            "fullPath": full_path,
            "content": sliced,
            "totalLines": total_lines,
            "size": content.len(),
            "largeFile": total_lines > LARGE_FILE_LINE_THRESHOLD,
            "range": { "startLine": range_start, "endLine": range_end },
            "truncated": truncated,
            "omittedLinesBefore": omit_before,
            "omittedLinesAfter": omit_after,
            "warning": warning,
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    if content.len() > MAX_FILE_SIZE {
        let payload = json!({
            "success": true,
            "path": rel_path,
            "fullPath": full_path,
            "totalLines": total_lines,
            "size": content.len(),
            "largeFile": true,
            "requiresLineRange": true,
            "content": "",
            "warning": format!(
                "File is too large to return safely ({} bytes, {} lines). Call file_read with start_line/end_line; maximum {MAX_SINGLE_READ_LINES} lines per call.",
                content.len(), total_lines
            ),
            "suggestedRange": {
                "startLine": 1,
                "endLine": std::cmp::min(DEFAULT_LINE_WINDOW, total_lines),
            }
        });
        return Ok(serde_json::to_string(&payload).unwrap());
    }

    let payload = json!({
        "success": true,
        "path": rel_path,
        "fullPath": full_path,
        "content": content,
        "totalLines": total_lines,
        "size": content.len(),
        "largeFile": false,
    });
    Ok(serde_json::to_string(&payload).unwrap())
}

/// Match TypeScript's `splitLines` semantics: split on `\r\n`, `\n`,
/// or bare `\r`, then return the resulting segment count. Returns 0
/// for the empty string (matching TS `splitLines("")` → `[]`).
fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    // 1 + number of line separators. Walk bytes to coalesce CRLF.
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

fn slice_window(
    content: &str,
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
) -> (String, usize, usize, usize, usize, bool) {
    let lines: Vec<&str> = if content.is_empty() {
        Vec::new()
    } else {
        content.split('\n').map(trim_trailing_cr).collect()
    };
    let total = lines.len().max(1);
    let explicit = start_line.is_some() || end_line.is_some();

    let start = start_line.unwrap_or(1).max(1).min(total);
    let max_window = max_lines
        .unwrap_or(if explicit { MAX_SINGLE_READ_LINES } else { DEFAULT_LINE_WINDOW })
        .min(MAX_SINGLE_READ_LINES);
    let natural_end = end_line.unwrap_or(start + max_window - 1);
    let end = natural_end.max(start).min(start + max_window - 1).min(total);

    let selected = if lines.is_empty() {
        String::new()
    } else {
        lines[start - 1..end].join("\n")
    };
    let omit_before = start.saturating_sub(1);
    let omit_after = total_lines.saturating_sub(end);
    let truncated = omit_before > 0 || omit_after > 0;
    (selected, start, end, omit_before, omit_after, truncated)
}

fn trim_trailing_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
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
    async fn reads_small_file_in_full() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello\nworld\n").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "a.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["content"], "hello\nworld\n");
        assert_eq!(body["largeFile"], false);
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(tmp.path().join("outside.txt"), "secret").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": "../outside.txt" }),
                &ctx_for(Some(workspace.clone())),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PolicyViolation(_)));
    }

    #[tokio::test]
    async fn returns_window_for_explicit_range() {
        let tmp = tempfile::tempdir().unwrap();
        let body: String = (1..=200).map(|i| format!("line {i}\n")).collect();
        std::fs::write(tmp.path().join("big.txt"), &body).unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "big.txt", "start_line": 5, "end_line": 7 }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["range"]["startLine"], 5);
        assert_eq!(parsed["range"]["endLine"], 7);
        assert_eq!(parsed["truncated"], true);
    }
}
