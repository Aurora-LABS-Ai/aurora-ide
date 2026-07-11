//! `read_lints` — run the workspace's native TypeScript, Python, and Rust checkers.
//!
//! The previous implementation emitted a frontend event and immediately
//! returned success. The frontend listener only logged that event, so agents
//! were told a project was clean without any diagnostics being collected.
//! This implementation runs fixed, read-only checker commands instead and
//! returns their actual output and exit status.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;

const CHECK_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_CHARS: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CheckSpec {
    name: &'static str,
    command: String,
    cwd: PathBuf,
}

pub struct ReadLintsTool {
    sink: Arc<dyn IdeEventSink>,
}

impl ReadLintsTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for ReadLintsTool {
    fn name(&self) -> &str {
        "read_lints"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "read_lints".into(),
            description:
                "Run the workspace's native TypeScript, Python, and Rust checkers and return \
                          their real diagnostics, exit codes, and success state. When paths are \
                          provided, only relevant language checkers run."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional file paths used to select the relevant language checkers."
                    }
                },
                "required": []
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let paths = parse_paths(&input)?;
        self.sink
            .emit_read_lints(&paths)
            .map_err(|e| ToolError::Execution(format!("failed to emit read_lints event: {e}")))?;

        let Some(workspace_root) = ctx.workspace_root.as_deref() else {
            return Ok(json!({
                "success": false,
                "paths": paths,
                "checks": [],
                "message": "Cannot run diagnostics because no workspace is open.",
            })
            .to_string());
        };

        let specs = select_checks(workspace_root, &paths);
        if specs.is_empty() {
            return Ok(json!({
                "success": false,
                "paths": paths,
                "checks": [],
                "message": "No supported TypeScript, Python, or Rust project checker was found for the requested paths.",
            })
            .to_string());
        }

        let mut checks = Vec::with_capacity(specs.len());
        let mut all_succeeded = true;

        for spec in specs {
            ctx.bail_if_cancelled()?;
            let cwd = spec.cwd.to_string_lossy().to_string();
            let result = tokio::select! {
                biased;
                () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
                result = run_checker(spec.command.clone(), cwd.clone()) => result,
            };

            match result {
                Ok(output) => {
                    all_succeeded &= output.success;
                    checks.push(json!({
                        "name": spec.name,
                        "command": spec.command,
                        "cwd": cwd,
                        "success": output.success,
                        "exitCode": output.exit_code,
                        "stdout": truncate_output(&output.stdout),
                        "stderr": truncate_output(&output.stderr),
                    }));
                }
                Err(error) => {
                    all_succeeded = false;
                    checks.push(json!({
                        "name": spec.name,
                        "command": spec.command,
                        "cwd": cwd,
                        "success": false,
                        "error": error,
                    }));
                }
            }
        }

        Ok(json!({
            "success": all_succeeded,
            "paths": paths,
            "checks": checks,
            "message": if all_succeeded {
                "All requested project checks passed."
            } else {
                "One or more project checks failed. Review the returned diagnostics."
            },
        })
        .to_string())
    }
}

fn parse_paths(input: &Value) -> Result<Vec<String>, ToolError> {
    match input.get("paths") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| {
                        ToolError::InvalidInput("`paths` must be an array of strings".into())
                    })
                    .map(str::to_string)
            })
            .collect(),
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => Err(ToolError::InvalidInput(
            "`paths` must be an array of strings".into(),
        )),
    }
}

fn select_checks(workspace_root: &Path, paths: &[String]) -> Vec<CheckSpec> {
    let check_all = paths.is_empty();
    let wants_typescript = check_all
        || paths.iter().any(|path| {
            matches!(
                extension(path).as_deref(),
                Some("ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs")
            )
        });
    let wants_rust = check_all
        || paths
            .iter()
            .any(|path| extension(path).as_deref() == Some("rs"));
    let wants_python = paths
        .iter()
        .any(|path| extension(path).as_deref() == Some("py"))
        || (check_all && has_python_project(workspace_root));

    let mut specs = Vec::new();
    if wants_typescript && workspace_root.join("tsconfig.json").is_file() {
        specs.push(CheckSpec {
            name: "typescript",
            command: typescript_command(workspace_root),
            cwd: workspace_root.to_path_buf(),
        });
    }

    if wants_rust {
        let cargo_root = if workspace_root.join("Cargo.toml").is_file() {
            Some(workspace_root.to_path_buf())
        } else {
            let tauri_root = workspace_root.join("src-tauri");
            tauri_root
                .join("Cargo.toml")
                .is_file()
                .then_some(tauri_root)
        };

        if let Some(cwd) = cargo_root {
            specs.push(CheckSpec {
                name: "rust",
                command: "cargo check --message-format=short".into(),
                cwd,
            });
        }
    }

    if wants_python {
        specs.push(CheckSpec {
            name: "python",
            command: python_command(workspace_root),
            cwd: workspace_root.to_path_buf(),
        });
    }

    specs
}

fn extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
}

fn typescript_command(workspace_root: &Path) -> String {
    if workspace_root.join("pnpm-lock.yaml").is_file() {
        "pnpm exec tsc -b --pretty false".into()
    } else if workspace_root.join("yarn.lock").is_file() {
        "yarn tsc -b --pretty false".into()
    } else {
        "npx --no-install tsc -b --pretty false".into()
    }
}

fn has_python_project(workspace_root: &Path) -> bool {
    [
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "setup.cfg",
        "Pipfile",
        "ruff.toml",
        ".ruff.toml",
    ]
    .iter()
    .any(|name| workspace_root.join(name).is_file())
}

fn python_command(workspace_root: &Path) -> String {
    let pyproject_uses_ruff = fs::read_to_string(workspace_root.join("pyproject.toml"))
        .map(|text| text.contains("[tool.ruff") || text.contains("ruff"))
        .unwrap_or(false);
    if pyproject_uses_ruff
        || workspace_root.join("ruff.toml").is_file()
        || workspace_root.join(".ruff.toml").is_file()
    {
        "python -m ruff check .".into()
    } else {
        "python -m compileall -q .".into()
    }
}

fn truncate_output(output: &str) -> String {
    if output.chars().count() <= MAX_OUTPUT_CHARS {
        return output.to_string();
    }

    let truncated: String = output.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{truncated}\n...[diagnostic output truncated]")
}

#[cfg(not(feature = "verify_only"))]
async fn run_checker(
    command: String,
    cwd: String,
) -> Result<crate::commands::CommandOutput, String> {
    crate::commands::execute_command(command, Some(cwd), None, Some(CHECK_TIMEOUT_MS)).await
}

#[cfg(feature = "verify_only")]
async fn run_checker(
    _command: String,
    _cwd: String,
) -> Result<crate::commands::CommandOutput, String> {
    Err("project checker execution disabled in verify_only".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::{
        NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio_util::sync::CancellationToken;

    fn ctx(workspace_root: Option<PathBuf>) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root,
            cancel_token: CancellationToken::new(),
        }
    }

    fn temp_workspace() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("aurora-read-lints-{nonce}"));
        fs::create_dir_all(&path).expect("create temp workspace");
        path
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        assert!(!tool.requires_permission());
    }

    #[tokio::test]
    async fn missing_workspace_is_an_explicit_failure() {
        let sink = RecordingIdeEventSink::new();
        let tool = ReadLintsTool::new(sink.clone());
        let out = tool.execute(json!({}), &ctx(None)).await.expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(false));
        assert!(parsed["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no workspace"));

        match &sink.events()[0] {
            RecordedEvent::ReadLints { paths } => assert!(paths.is_empty()),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn selects_only_checker_matching_requested_paths() {
        let root = temp_workspace();
        fs::write(root.join("tsconfig.json"), "{}").expect("tsconfig");
        fs::write(root.join("pnpm-lock.yaml"), "").expect("lockfile");
        fs::create_dir_all(root.join("src-tauri")).expect("tauri dir");
        fs::write(root.join("src-tauri/Cargo.toml"), "[package]").expect("manifest");

        let ts = select_checks(&root, &["src/App.tsx".into()]);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].name, "typescript");
        assert!(ts[0].command.starts_with("pnpm exec tsc"));

        let rust = select_checks(&root, &["src-tauri/src/lib.rs".into()]);
        assert_eq!(rust.len(), 1);
        assert_eq!(rust[0].name, "rust");

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn empty_paths_selects_all_available_checkers() {
        let root = temp_workspace();
        fs::write(root.join("tsconfig.json"), "{}").expect("tsconfig");
        fs::write(root.join("Cargo.toml"), "[workspace]").expect("manifest");
        let checks = select_checks(&root, &[]);
        assert_eq!(checks.len(), 2);
        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn python_prefers_ruff_and_falls_back_to_native_syntax_checking() {
        let root = temp_workspace();
        let requested = vec!["app.py".into()];

        let fallback = select_checks(&root, &requested);
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].name, "python");
        assert_eq!(fallback[0].command, "python -m compileall -q .");

        fs::write(
            root.join("pyproject.toml"),
            "[tool.ruff]\nline-length = 100",
        )
        .expect("pyproject");
        let configured = select_checks(&root, &requested);
        assert_eq!(configured[0].command, "python -m ruff check .");

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[tokio::test]
    async fn rejects_paths_not_array() {
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"paths": "single.rs"}), &ctx(None))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_non_string_path_entry() {
        let tool = ReadLintsTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"paths": [123]}), &ctx(None))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
