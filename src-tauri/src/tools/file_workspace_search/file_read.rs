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

use super::resolve_path_for_read;

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

    /// Pure disk read — safe alongside other reads in the same batch.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "file_read".into(),
            description: "Read file content safely using exactly one form. For ONE file, pass a \
                          non-empty `path` and optional start_line/end_line/max_lines; omit `paths`. \
                          For SEVERAL files, pass a non-empty `paths` array; omit `path` and all line \
                          range fields. Never send `paths: []`. Small files return in full; large files \
                          return a bounded line window. A missing path reports exists=false rather than failing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Single-file form only: one non-empty file path. Omit `paths`."
                    },
                    "paths": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": { "type": "string", "minLength": 1 },
                        "description": "Batch form only: 1-20 non-empty file paths. Omit `path` and line range fields; never send an empty array."
                    },
                    "start_line": { "type": "number", "description": "Single-file form: 1-based first line to return." },
                    "end_line": { "type": "number", "description": "Single-file form: 1-based inclusive last line to return." },
                    "max_lines": { "type": "number", "description": "Single-file form: maximum lines to return from start_line." }
                },
                // NOTE: the "exactly one of `path` / `paths`" contract is
                // carried by the descriptions above and ENFORCED at runtime in
                // `execute` (both-present and empty-array cases are rejected).
                // We deliberately do NOT express it with a top-level `oneOf`:
                // strict tool-schema validators (xAI/grok in particular) reject
                // `oneOf`/`anyOf`/`allOf` in function parameters with HTTP 400,
                // which would break every agent turn on those providers.
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let path = match input.get("path") {
            Some(Value::String(path)) if !path.trim().is_empty() => Some(path.as_str()),
            Some(Value::String(_)) | Some(Value::Null) | None => None,
            Some(_) => {
                return Err(ToolError::InvalidInput(
                    "`path` must be a non-empty string when provided".into(),
                ))
            }
        };
        let paths = match input.get("paths") {
            Some(Value::Array(paths)) if !paths.is_empty() => Some(paths.as_slice()),
            Some(Value::Array(_)) | Some(Value::Null) | None => None,
            Some(_) => {
                return Err(ToolError::InvalidInput(
                    "`paths` must be a non-empty array of file path strings when provided".into(),
                ))
            }
        };

        if path.is_some() && paths.is_some() {
            return Err(ToolError::InvalidInput(
                "use exactly one file_read form: `path` for one file or `paths` for several files; do not send both"
                    .into(),
            ));
        }

        // An empty `paths` array is treated as an omitted optional placeholder
        // only when a valid single-file `path` is present. This keeps a model's
        // redundant default from overriding the unambiguous requested read.
        if let Some(arr) = paths {
            if input.get("start_line").is_some()
                || input.get("end_line").is_some()
                || input.get("max_lines").is_some()
            {
                return Err(ToolError::InvalidInput(
                    "`start_line`, `end_line`, and `max_lines` only work with single-file `path`; omit them when using `paths`"
                        .into(),
                ));
            }
            if arr.iter().any(|entry| {
                entry
                    .as_str()
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
            }) {
                return Err(ToolError::InvalidInput(
                    "every entry in `paths` must be a non-empty file path string".into(),
                ));
            }

            // Record each requested path as "seen" so a later file_edit knows
            // the agent looked at it, then delegate to the parallel reader.
            for entry in arr {
                if let Some(p) = entry.as_str() {
                    if let Ok(resolved) = resolve_path_for_read(
                        p,
                        ctx.workspace_root.as_deref(),
                        ctx.allow_outside_workspace,
                    ) {
                        super::read_tracker::record(&ctx.session_id, &resolved.to_string_lossy());
                    }
                }
            }
            return super::multi_file_read::read_many(input, ctx).await;
        }

        let path = path.ok_or_else(|| {
            if input.get("paths").and_then(Value::as_array).is_some() {
                ToolError::InvalidInput(
                    "`paths` must contain at least one file; use `path` for a single file and omit `paths`"
                        .into(),
                )
            } else {
                ToolError::InvalidInput(
                    "provide exactly one file_read form: non-empty `path` or non-empty `paths`"
                        .into(),
                )
            }
        })?;

        let resolved = match resolve_path_for_read(
            path,
            ctx.workspace_root.as_deref(),
            ctx.allow_outside_workspace,
        ) {
            Ok(resolved) => resolved,
            Err(ToolError::Execution(err)) => {
                return Ok(serde_json::to_string(&json!({
                    "success": false,
                    "path": path,
                    "error": format!("Invalid file path: {err}"),
                }))
                .unwrap());
            }
            Err(err) => return Err(err),
        };
        let start_line = input
            .get("start_line")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let end_line = input
            .get("end_line")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let max_lines = input
            .get("max_lines")
            .and_then(Value::as_u64)
            .map(|n| n as usize);

        let path_owned = resolved.to_string_lossy().to_string();
        let resolved_for_record = path_owned.clone();
        let raw_path = path.to_string();

        let body = tokio::task::spawn_blocking(move || {
            read_with_policy(&path_owned, &raw_path, start_line, end_line, max_lines)
        })
        .await
        .map_err(|err| ToolError::Execution(format!("file_read task panicked: {err}")))??;

        // Mark the file seen so a subsequent file_edit passes the
        // read-before-edit guard. Recording the attempt (even on a miss)
        // is harmless: file_edit independently fails on a missing file.
        super::read_tracker::record(&ctx.session_id, &resolved_for_record);

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
            // `exists: false` folds in the old `file_exists` tool — callers can
            // probe a path's presence with file_read and branch on this flag.
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "exists": false,
                "path": rel_path,
                "fullPath": full_path,
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
        .unwrap_or(if explicit {
            MAX_SINGLE_READ_LINES
        } else {
            DEFAULT_LINE_WINDOW
        })
        .min(MAX_SINGLE_READ_LINES);
    let natural_end = end_line.unwrap_or(start + max_window - 1);
    let end = natural_end
        .max(start)
        .min(start + max_window - 1)
        .min(total);

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
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: workspace,
            cancel_token: CancellationToken::new(),
        }
    }

    #[test]
    fn schema_requires_one_non_empty_read_form() {
        let schema = FileReadTool.schema();
        // The single-vs-batch contract is enforced in `execute`, not with a
        // top-level `oneOf` — strict providers (xAI/grok) 400 on `oneOf`.
        assert!(schema.input_schema.get("oneOf").is_none());
        assert_eq!(schema.input_schema["properties"]["paths"]["minItems"], 1);
        assert_eq!(schema.input_schema["properties"]["path"]["minLength"], 1);
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
    async fn empty_paths_placeholder_does_not_override_single_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("knowledge.md"), "project memory").unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({
                    "path": "knowledge.md",
                    "paths": [],
                    "start_line": 1,
                    "end_line": 220,
                    "max_lines": 220
                }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("an empty batch placeholder should not hide a valid single path");
        let body: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["content"], "project memory");
    }

    #[tokio::test]
    async fn rejects_ambiguous_non_empty_path_forms() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "path": "one.md", "paths": ["two.md"] }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(message) if message.contains("do not send both"))
        );
    }

    #[tokio::test]
    async fn rejects_line_ranges_on_batch_reads() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let err = tool
            .execute(
                serde_json::json!({ "paths": ["one.md", "two.md"], "start_line": 5 }),
                &ctx_for(None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(message) if message.contains("only work with single-file `path`"))
        );
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
    async fn missing_file_returns_json_error() {
        let tmp = tempfile::tempdir().unwrap();

        let tool: Arc<dyn ToolExecutor> = Arc::new(FileReadTool);
        let result = tool
            .execute(
                serde_json::json!({ "path": "missing.txt" }),
                &ctx_for(Some(tmp.path().to_path_buf())),
            )
            .await
            .expect("missing file should not fail the whole tool call");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("Failed to read file"));
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
