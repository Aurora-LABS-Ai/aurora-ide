//! `grep` — ripgrep-backed code search. Wraps
//! `crate::commands::ripgrep_search` and post-processes the
//! response (file paths -> workspace-relative) the same way the
//! TS executor does.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::{ripgrep_search, RipgrepSearchRequest};
use crate::tools::timeout::TimeoutPolicy;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MIN_TIMEOUT_MS: u64 = 1_000;

/// Read the same way `shell_execute` reads its own — see
/// [`crate::tools::timeout`]. `ripgrep_search` enforces the number it is given,
/// so this tool declares no `timeout_policy()`: a second clock on the outside
/// would only be able to abandon a search that is already stopping itself.
const TIMEOUT: TimeoutPolicy = TimeoutPolicy::new(
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "Narrow `path` or `glob` before raising `timeout` — a search this slow is usually searching \
     somewhere it does not need to.",
);

pub struct GrepTool;

#[async_trait]
impl ToolExecutor for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    /// Read-only search — safe alongside other reads in the same batch.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "grep".into(),
            description: "Search the codebase for exact text or regex patterns using ripgrep. \
                          Output modes: 'content' (default), 'files_with_matches', 'count'."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Pattern to search for." },
                    "path": { "type": "string", "default": ".", "description": "Path to search in (file or directory)." },
                    "output_mode": {
                        "type": "string",
                        "enum": ["content", "files_with_matches", "count"],
                        "default": "content",
                    },
                    "is_regex": { "type": "boolean", "default": true },
                    "case_insensitive": { "type": "boolean", "default": false },
                    "glob": {
                        "type": "string",
                        "description": "Limit the search to matching files, e.g. `**/*.rs`. \
                                        Brace alternation works (`**/*.{ts,tsx}`), and several \
                                        globs can be comma-separated (`src/**/*.ts, tests/**/*.ts`). \
                                        Prefix a glob with `!` to exclude.",
                    },
                    "context_lines": { "type": "number", "default": 0 },
                    "max_results": {
                        "type": "number",
                        "default": 50,
                        "description": "Maximum results returned in TOTAL — matches for \
                                        `content`, files for the other modes. When more exist the \
                                        reply sets `truncated: true` and `message` names the way \
                                        to narrow or widen the search.",
                    },
                    "timeout": { "type": "number", "default": 30000 }
                },
                "required": ["pattern"],
                "additionalProperties": true,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let pattern = input
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`pattern` must be a string".into()))?
            .to_string();

        let raw_path = input
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(".")
            .to_string();

        // Resolve `path` against the workspace, but tolerate `.`
        // (the default) by mapping it to the workspace root.
        let search_path: String = match ctx.workspace_root.as_deref() {
            Some(root) => {
                let candidate = if raw_path == "." {
                    root.to_path_buf()
                } else {
                    match super::resolve_path(&raw_path, Some(root)) {
                        Ok(path) => path,
                        Err(err) => {
                            return Ok(serde_json::to_string(&json!({
                                "success": false,
                                "error": format!("Invalid search path `{raw_path}`: {err}"),
                                "pattern": pattern,
                                "tool": "grep",
                                "matches": null,
                                "files": null,
                                "counts": null,
                                "total_matches": null,
                                "total_files": null,
                                "truncated": null,
                            }))
                            .unwrap());
                        }
                    }
                };
                candidate.to_string_lossy().to_string()
            }
            None => raw_path.clone(),
        };

        let request = RipgrepSearchRequest {
            case_insensitive: input.get("case_insensitive").and_then(Value::as_bool),
            context_lines: input
                .get("context_lines")
                .and_then(Value::as_u64)
                .map(|n| n as u32),
            glob: input
                .get("glob")
                .and_then(Value::as_str)
                .map(str::to_string),
            is_regex: input.get("is_regex").and_then(Value::as_bool),
            max_results: input
                .get("max_results")
                .and_then(Value::as_u64)
                .map(|n| n as u32),
            output_mode: input
                .get("output_mode")
                .and_then(Value::as_str)
                .map(str::to_string),
            path: search_path.clone(),
            pattern,
            timeout_ms: Some(TIMEOUT.resolve(&input)),
        };

        let response = ripgrep_search(request)
            .await
            .map_err(ToolError::Execution)?;
        let mut value = serde_json::to_value(&response).map_err(|e| {
            ToolError::Execution(format!("failed to serialize ripgrep response: {e}"))
        })?;

        // Convert absolute file paths back to workspace-relative
        // form when we have a workspace root, matching the TS
        // executor.
        if let Some(root) = ctx.workspace_root.as_deref() {
            relativize_paths(&mut value, root);
        }

        Ok(serde_json::to_string(&value).unwrap())
    }
}

fn relativize_paths(value: &mut Value, root: &Path) {
    let root_norm = root.to_string_lossy().replace('\\', "/");
    let root_norm = root_norm.trim_end_matches('/').to_string();
    let prefix = format!("{root_norm}/");

    let to_rel = |path: &str| -> String {
        let normalized = path.replace('\\', "/");
        if let Some(stripped) = normalized.strip_prefix(&prefix) {
            stripped.to_string()
        } else {
            normalized
        }
    };

    if let Some(arr) = value.get_mut("files").and_then(|v| v.as_array_mut()) {
        for entry in arr.iter_mut() {
            if let Some(s) = entry.as_str() {
                *entry = Value::String(to_rel(s));
            }
        }
    }
    if let Some(arr) = value.get_mut("counts").and_then(|v| v.as_array_mut()) {
        for entry in arr.iter_mut() {
            if let Some(file) = entry.get_mut("file").and_then(|v| v.as_str()) {
                let rel = to_rel(file);
                entry["file"] = Value::String(rel);
            }
        }
    }
    if let Some(arr) = value.get_mut("matches").and_then(|v| v.as_array_mut()) {
        for entry in arr.iter_mut() {
            if let Some(file) = entry.get_mut("file").and_then(|v| v.as_str()) {
                let rel = to_rel(file);
                entry["file"] = Value::String(rel);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relativize_strips_workspace_prefix() {
        let mut v = json!({
            "files": ["/ws/src/a.rs", "/ws/src/b.rs"],
            "matches": [{ "file": "/ws/src/a.rs", "line": 1 }],
            "counts": [{ "file": "/ws/src/a.rs", "count": 3 }],
        });
        relativize_paths(&mut v, Path::new("/ws"));
        assert_eq!(v["files"][0], "src/a.rs");
        assert_eq!(v["matches"][0]["file"], "src/a.rs");
        assert_eq!(v["counts"][0]["file"], "src/a.rs");
    }

    #[test]
    fn relativize_handles_windows_separators() {
        let mut v = json!({ "files": ["C:\\ws\\src\\a.rs"] });
        relativize_paths(&mut v, Path::new("C:/ws"));
        assert_eq!(v["files"][0], "src/a.rs");
    }

    #[tokio::test]
    async fn invalid_path_returns_structured_error() {
        use crate::agent_runtime::tool_executor::ToolContext;
        use std::sync::Arc;
        use tokio_util::sync::CancellationToken;

        let tmp = tempfile::tempdir().unwrap();
        let tool: Arc<dyn ToolExecutor> = Arc::new(GrepTool);
        let out = tool
            .execute(
                serde_json::json!({
                    "pattern": "anything",
                    "path": "../outside.txt",
                }),
                &ToolContext {
                    allow_outside_workspace: false,
                    turn_id: "t".into(),
                    tool_call_id: "c".into(),
                    thread_id: "s".into(),
                    workspace_root: Some(tmp.path().to_path_buf()),
                    cancel_token: CancellationToken::new(),
                    spill_dir: None,
                },
            )
            .await
            .expect("path errors should be structured grep results");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("Invalid search path"));
    }
}
