//! `glob` — find files by name or path shape.
//!
//! The primitive Aurora was missing. A model that knows a *name* but not a
//! *path* previously had only two options: walk `workspace_tree` and hope the
//! file survived the node budget, or `grep` for some string it guessed was
//! inside the file. Both are indirect, and both are expensive compared with the
//! question being asked.
//!
//! Implemented on top of ripgrep's `--files` mode rather than a hand-rolled
//! walker, because that binary is already bundled ([`crate::sidecar`]) and
//! already implements the parts that are easy to get wrong: `.gitignore`
//! semantics, symlink loops, and fast parallel traversal. It also means `glob`
//! and `grep` agree about which files exist — the previous split, where
//! `workspace_tree` listed files `grep` would never search, is a source of
//! contradictions a model cannot resolve.
//!
//! Results are sorted by modification time, newest first. On an unfamiliar
//! repository that is a weak signal; on the repository someone is *working in*
//! it is a strong one, because the files touched most recently are almost
//! always the ones a task is about.

use std::process::Stdio;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Command as TokioCommand;

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

/// Keep ripgrep from flashing a console window on Windows. `tokio`'s `Command`
/// exposes `creation_flags` directly, so no `CommandExt` import is needed.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1_000;
const TIMEOUT_MS: u64 = 30_000;

pub struct GlobTool;

#[async_trait]
impl ToolExecutor for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }

    /// Read-only listing — safe alongside other reads in the same batch.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "glob".into(),
            description: "Find files by name or path pattern — the fastest way to locate a file \
                          you can name. Supports standard globs (`**/*.rs`, `src/**/test_*.py`, \
                          `*.{ts,tsx}`). Returns workspace-relative paths, most recently modified \
                          first. Honours .gitignore. Use this instead of workspace_tree when you \
                          know what the file is called, and instead of grep when you are matching \
                          a filename rather than file contents."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. `**/*.tsx` or `src/**/use*.ts`." },
                    "path": { "type": "string", "description": "Directory to search in. Defaults to the workspace root." },
                    "limit": { "type": "number", "default": 100, "description": "Maximum paths to return (max 1000)." },
                    "include_hidden": { "type": "boolean", "default": false, "description": "Also match inside dot-directories." }
                },
                "required": ["pattern"],
                "additionalProperties": false,
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
        if pattern.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "`pattern` must not be empty".into(),
            ));
        }

        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .map(|n| (n as usize).clamp(1, MAX_LIMIT))
            .unwrap_or(DEFAULT_LIMIT);
        let include_hidden = input
            .get("include_hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let raw_path = input.get("path").and_then(Value::as_str).unwrap_or(".");
        let search_root = match ctx.workspace_root.as_deref() {
            Some(root) if raw_path == "." => root.to_path_buf(),
            Some(root) => super::resolve_path(raw_path, Some(root))?,
            None => std::path::PathBuf::from(raw_path),
        };

        let Some(rg) = crate::sidecar::ripgrep() else {
            return Err(ToolError::Execution(
                crate::sidecar::ripgrep_missing_message(),
            ));
        };

        let mut cmd = TokioCommand::new(&rg.path);
        // `--files` lists candidates instead of searching them; `--glob` then
        // filters that list. `--null` separates paths with NUL so a filename
        // containing a newline cannot split one result into two.
        //
        // Run IN the search root with no path argument, rather than passing the
        // root as an argument. ripgrep anchors a slash-bearing glob
        // (`src/**/*.ts`) to the working directory, not to the path operand, so
        // passing an absolute root made every such pattern silently match
        // nothing while bare patterns like `**/*.rs` kept working — the worst
        // shape of bug, since the tool looks functional. Running in the root
        // also makes ripgrep emit already-relative paths.
        cmd.current_dir(&search_root)
            .arg("--files")
            .arg("--null")
            .arg("--no-messages")
            .arg("--glob")
            .arg(&pattern);
        if include_hidden {
            cmd.arg("--hidden");
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = cmd.spawn().map_err(|error| {
            ToolError::Execution(format!(
                "Failed to execute ripgrep at {} ({}): {error}",
                rg.path.display(),
                rg.source.as_str()
            ))
        })?;

        let output = tokio::select! {
            biased;
            () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
            result = tokio::time::timeout(
                std::time::Duration::from_millis(TIMEOUT_MS),
                child.wait_with_output(),
            ) => match result {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    return Err(ToolError::Execution(format!("ripgrep failed: {error}")))
                }
                Err(_) => {
                    return Err(ToolError::Execution(format!(
                        "glob timed out after {TIMEOUT_MS}ms — narrow `pattern` or pass `path`"
                    )))
                }
            },
        };

        // Exit 1 means "no matches", which is a normal answer, not a failure.
        if !output.status.success() && output.status.code() != Some(1) {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                // The overwhelmingly common cause, and the one the model can
                // act on without another round trip.
                format!("ripgrep rejected the pattern `{pattern}`")
            } else {
                stderr
            };
            return Err(ToolError::InvalidInput(format!(
                "{detail}. Use forward slashes and standard glob syntax, e.g. `**/*.rs`."
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut matches: Vec<(std::time::SystemTime, String)> = stdout
            .split('\0')
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                // ripgrep emits paths relative to the working directory we set,
                // so mtime needs them re-anchored.
                let modified = std::fs::metadata(search_root.join(line))
                    .and_then(|meta| meta.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                (modified, normalize_relative(line))
            })
            .collect();

        // Newest first — on the repo someone is actually working in, recency is
        // the best cheap proxy for relevance.
        matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

        let total = matches.len();
        let files: Vec<String> = matches.into_iter().take(limit).map(|(_, p)| p).collect();
        let truncated = total > files.len();

        let mut payload = json!({
            "success": true,
            "tool": "glob",
            "pattern": pattern,
            "files": files,
            "count": total,
            "truncated": truncated,
        });

        if truncated {
            // Name the omission and the way out, the same contract
            // `workspace_tree` follows.
            payload["note"] = json!(format!(
                "Showing {limit} of {total} matches (newest first). Narrow `pattern`, scope with \
                 `path`, or raise `limit` to see the rest."
            ));
        } else if total == 0 {
            payload["note"] = json!(
                "No files matched. Check the pattern uses forward slashes and `**` to cross \
                 directories (e.g. `**/*.ts` rather than `*.ts`), or search contents with `grep`."
            );
        }

        Ok(serde_json::to_string(&payload).unwrap())
    }
}

/// Forward-slashed and free of a `./` prefix — the same shape `grep` returns,
/// so a path from either tool can be handed straight to `file_read`.
///
/// Paths arrive already relative because ripgrep runs inside the search root;
/// this only normalises separators (Windows) and strips the leading `./` that
/// some ripgrep invocations emit.
fn normalize_relative(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for(root: &Path) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: Some(root.to_path_buf()),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    async fn run(input: Value, root: &Path) -> Value {
        let tool: Arc<dyn ToolExecutor> = Arc::new(GlobTool);
        let out = tool.execute(input, &ctx_for(root)).await.expect("ok");
        serde_json::from_str(&out).unwrap()
    }

    fn files(parsed: &Value) -> Vec<String> {
        parsed["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/components")).unwrap();
        std::fs::create_dir_all(tmp.path().join("docs")).unwrap();
        std::fs::write(tmp.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(tmp.path().join("src/lib.rs"), "pub fn a() {}").unwrap();
        std::fs::write(tmp.path().join("src/components/Button.tsx"), "x").unwrap();
        std::fs::write(tmp.path().join("docs/readme.md"), "# hi").unwrap();
        tmp
    }

    #[tokio::test]
    async fn matches_by_extension_across_directories() {
        let tmp = fixture();
        let parsed = run(json!({ "pattern": "**/*.rs" }), tmp.path()).await;
        let mut found = files(&parsed);
        found.sort();
        assert_eq!(found, vec!["src/lib.rs", "src/main.rs"]);
        assert_eq!(parsed["count"], 2);
        assert_eq!(parsed["truncated"], false);
    }

    #[tokio::test]
    async fn matches_a_nested_path_shape() {
        let tmp = fixture();
        let parsed = run(json!({ "pattern": "src/components/*.tsx" }), tmp.path()).await;
        assert_eq!(files(&parsed), vec!["src/components/Button.tsx"]);
    }

    #[tokio::test]
    async fn returns_forward_slashed_workspace_relative_paths() {
        let tmp = fixture();
        let parsed = run(json!({ "pattern": "**/*.md" }), tmp.path()).await;
        let found = files(&parsed);
        assert_eq!(found, vec!["docs/readme.md"]);
        assert!(!found[0].contains('\\'), "paths must be forward-slashed");
    }

    /// A truncated result must state the real total and how to get the rest —
    /// the same contract `workspace_tree` now follows.
    #[tokio::test]
    async fn truncation_reports_the_true_total_and_a_way_out() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..12 {
            std::fs::write(tmp.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        let parsed = run(json!({ "pattern": "*.txt", "limit": 5 }), tmp.path()).await;
        assert_eq!(files(&parsed).len(), 5);
        assert_eq!(parsed["count"], 12, "the true total, not the shown count");
        assert_eq!(parsed["truncated"], true);
        assert!(parsed["note"].as_str().unwrap().contains("12"));
    }

    #[tokio::test]
    async fn no_matches_is_a_normal_answer_with_guidance() {
        let tmp = fixture();
        let parsed = run(json!({ "pattern": "**/*.zzz" }), tmp.path()).await;
        assert_eq!(parsed["success"], true);
        assert!(files(&parsed).is_empty());
        assert_eq!(parsed["count"], 0);
        assert!(parsed["note"].as_str().unwrap().contains("grep"));
    }

    #[tokio::test]
    async fn hidden_files_need_opting_in() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".config")).unwrap();
        std::fs::write(tmp.path().join(".config/app.json"), "{}").unwrap();

        let hidden_off = run(json!({ "pattern": "**/*.json" }), tmp.path()).await;
        assert!(files(&hidden_off).is_empty());

        let hidden_on = run(
            json!({ "pattern": "**/*.json", "include_hidden": true }),
            tmp.path(),
        )
        .await;
        assert_eq!(files(&hidden_on), vec![".config/app.json"]);
    }

    #[tokio::test]
    async fn rejects_an_empty_pattern() {
        let tmp = fixture();
        let tool: Arc<dyn ToolExecutor> = Arc::new(GlobTool);
        let err = tool
            .execute(json!({ "pattern": "   " }), &ctx_for(tmp.path()))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn pre_cancelled_context_short_circuits() {
        let tmp = fixture();
        let ctx = ctx_for(tmp.path());
        ctx.cancel_token.cancel();
        let tool: Arc<dyn ToolExecutor> = Arc::new(GlobTool);
        let err = tool
            .execute(json!({ "pattern": "**/*" }), &ctx)
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
    }

    /// The `path` argument must actually scope the search, and results stay
    /// relative to that scope.
    #[tokio::test]
    async fn path_scopes_the_search() {
        let tmp = fixture();
        let parsed = run(json!({ "pattern": "*.rs", "path": "src" }), tmp.path()).await;
        let mut found = files(&parsed);
        found.sort();
        assert_eq!(found, vec!["lib.rs", "main.rs"]);
    }

    #[test]
    fn normalize_relative_forward_slashes_and_drops_dot_prefix() {
        assert_eq!(normalize_relative(r"src\a.rs"), "src/a.rs");
        assert_eq!(normalize_relative("./src/a.rs"), "src/a.rs");
        assert_eq!(normalize_relative("src/a.rs"), "src/a.rs");
    }
}
