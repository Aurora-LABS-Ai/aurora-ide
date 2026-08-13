//! `read_lints` — run native project checkers plus dependency-free JavaScript
//! syntax checks for vanilla web projects.
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

/// Keep project checkers from flashing a console window on Windows. `tokio`'s
/// `Command` exposes `creation_flags` directly, so no `CommandExt` import is
/// needed (same pattern as the glob/ripgrep tool).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CHECK_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_CHARS: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CheckSpec {
    name: &'static str,
    command: CheckCommand,
    cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CheckCommand {
    Shell(String),
    Program {
        executable: &'static str,
        args: Vec<String>,
    },
}

impl CheckCommand {
    fn display(&self) -> String {
        match self {
            Self::Shell(command) => command.clone(),
            Self::Program { executable, args } => std::iter::once((*executable).to_string())
                .chain(args.iter().map(|arg| format!("{arg:?}")))
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
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

    /// Read-only diagnostics pass — mutates nothing.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "read_lints".into(),
            description:
                "Run the workspace's configured TypeScript, Python, and Rust checkers plus \
                          dependency-free Node syntax checks for vanilla JavaScript. Returns \
                          real output, exit codes, and guidance for HTML/CSS paths that need a \
                          project lint or test command."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional file paths. They select the relevant language \
                            checkers, and diagnostics referencing them are singled out in \
                            `requestedPathDiagnostics` — the checkers themselves are project-wide, \
                            so other files' pre-existing errors may still appear in the raw output."
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
                "message": validation_guidance(workspace_root, &paths),
            })
            .to_string());
        }

        let needles = requested_path_needles(workspace_root, &paths);
        let mut checks = Vec::with_capacity(specs.len());
        let mut all_succeeded = true;
        let mut requested_hits = 0usize;

        for spec in specs {
            ctx.bail_if_cancelled()?;
            let cwd = spec.cwd.to_string_lossy().to_string();
            let command = spec.command.display();
            let result = tokio::select! {
                biased;
                () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
                result = run_checker(spec.command, cwd.clone()) => result,
            };

            match result {
                Ok(output) => {
                    all_succeeded &= output.success;
                    let mut check = json!({
                        "name": spec.name,
                        "command": command,
                        "cwd": cwd,
                        "success": output.success,
                        "exitCode": output.exit_code,
                        "stdout": truncate_output(&output.stdout),
                        "stderr": truncate_output(&output.stderr),
                    });
                    // The checkers are project-wide; when the caller named the
                    // files they touched, single out the diagnostic lines that
                    // reference them so "did MY change break anything?" has an
                    // at-a-glance answer instead of a manual scan.
                    if !needles.is_empty() && !output.success {
                        let combined = format!("{}\n{}", output.stdout, output.stderr);
                        let hits = diagnostics_for_requested(&combined, &needles);
                        requested_hits += hits.len();
                        check["requestedPathDiagnostics"] = json!(hits);
                    }
                    checks.push(check);
                }
                Err(error) => {
                    all_succeeded = false;
                    checks.push(json!({
                        "name": spec.name,
                        "command": command,
                        "cwd": cwd,
                        "success": false,
                        "error": error,
                    }));
                }
            }
        }

        let guidance = uncovered_validation_guidance(workspace_root, &paths);
        let message = if all_succeeded {
            if guidance.is_some() {
                "Available checks passed. Review the validation guidance for uncovered file types."
                    .to_string()
            } else {
                "All requested project checks passed.".to_string()
            }
        } else if !needles.is_empty() {
            if requested_hits == 0 {
                "Checks reported diagnostics, but none reference the requested paths — they are \
                 likely pre-existing issues elsewhere in the project."
                    .to_string()
            } else {
                format!(
                    "{requested_hits} diagnostic line{} reference the requested paths (see \
                     requestedPathDiagnostics). Other output may be pre-existing.",
                    if requested_hits == 1 { "" } else { "s" },
                )
            }
        } else {
            "One or more project checks failed. Review the returned diagnostics.".to_string()
        };
        Ok(json!({
            "success": all_succeeded,
            "paths": paths,
            "checks": checks,
            "guidance": guidance,
            "message": message,
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
            command: CheckCommand::Shell(typescript_command(workspace_root)),
            cwd: workspace_root.to_path_buf(),
        });
    } else if wants_typescript {
        specs.extend(vanilla_javascript_checks(workspace_root, paths));
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
                command: CheckCommand::Shell("cargo check --message-format=short".into()),
                cwd,
            });
        }
    }

    if wants_python {
        specs.push(CheckSpec {
            name: "python",
            command: CheckCommand::Shell(python_command(workspace_root)),
            cwd: workspace_root.to_path_buf(),
        });
    }

    specs
}

fn vanilla_javascript_checks(workspace_root: &Path, paths: &[String]) -> Vec<CheckSpec> {
    let files = if paths.is_empty() {
        discover_workspace_files(workspace_root, &["js", "mjs", "cjs"], 100)
    } else {
        paths
            .iter()
            .filter(|path| matches!(extension(path).as_deref(), Some("js" | "mjs" | "cjs")))
            .filter_map(|path| workspace_file(workspace_root, path))
            .collect()
    };
    files
        .into_iter()
        .map(|path| CheckSpec {
            name: "javascript-syntax",
            command: CheckCommand::Program {
                executable: "node",
                args: vec!["--check".into(), checker_path_arg(workspace_root, &path)],
            },
            cwd: workspace_root.to_path_buf(),
        })
        .collect()
}

fn checker_path_arg(workspace_root: &Path, path: &Path) -> String {
    let canonical_root = workspace_root.canonicalize().ok();
    canonical_root
        .as_deref()
        .and_then(|root| path.strip_prefix(root).ok())
        .or_else(|| path.strip_prefix(workspace_root).ok())
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn discover_workspace_files(
    workspace_root: &Path,
    extensions: &[&str],
    limit: usize,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![workspace_root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut paths: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        paths.sort();
        for path in paths.into_iter().rev() {
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if !matches!(
                    name,
                    ".git" | "node_modules" | "dist" | "build" | "target" | "coverage"
                ) {
                    pending.push(path);
                }
                continue;
            }
            if path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(str::to_ascii_lowercase)
                    .is_some_and(|extension| extensions.contains(&extension.as_str()))
            {
                files.push(path);
                if files.len() >= limit {
                    return files;
                }
            }
        }
    }
    files
}

fn workspace_file(workspace_root: &Path, requested: &str) -> Option<PathBuf> {
    let root = workspace_root.canonicalize().ok()?;
    let requested = Path::new(requested);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let candidate = candidate.canonicalize().ok()?;
    (candidate.is_file() && candidate.starts_with(&root)).then_some(candidate)
}

fn validation_guidance(workspace_root: &Path, paths: &[String]) -> String {
    uncovered_validation_guidance(workspace_root, paths).unwrap_or_else(|| {
        let suggested_command = configured_validation_command(workspace_root);
        format!(
            "No checker matched the requested paths. Run the project's validation command with shell_execute (suggested: `{suggested_command}`)."
        )
    })
}

fn uncovered_validation_guidance(workspace_root: &Path, paths: &[String]) -> Option<String> {
    let extensions: std::collections::BTreeSet<_> =
        paths.iter().filter_map(|path| extension(path)).collect();
    let has_html_or_css = extensions
        .iter()
        .any(|extension| matches!(extension.as_str(), "html" | "htm" | "css"))
        || (paths.is_empty()
            && !workspace_root.join("tsconfig.json").is_file()
            && !discover_workspace_files(workspace_root, &["html", "htm", "css"], 1).is_empty());
    let has_jsx_or_typescript = extensions
        .iter()
        .any(|extension| matches!(extension.as_str(), "jsx" | "ts" | "tsx" | "mts" | "cts"));
    let suggested_command = configured_validation_command(workspace_root);

    if has_html_or_css {
        return Some(format!(
            "No HTML or CSS parser is configured for this workspace. Run the project's validation command with shell_execute (suggested: `{suggested_command}`), or add an HTML/CSS linter for structured diagnostics."
        ));
    }
    if has_jsx_or_typescript && !workspace_root.join("tsconfig.json").is_file() {
        return Some(format!(
            "These JSX or TypeScript paths need a project checker. Add a tsconfig.json or configured lint script, then run `{suggested_command}` with shell_execute."
        ));
    }
    None
}

fn configured_validation_command(workspace_root: &Path) -> String {
    let package_json = fs::read_to_string(workspace_root.join("package.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok());
    let script = package_json
        .as_ref()
        .and_then(|package| package.get("scripts"))
        .and_then(Value::as_object)
        .and_then(|scripts| {
            ["lint", "check", "validate", "test"]
                .into_iter()
                .find(|name| scripts.get(*name).and_then(Value::as_str).is_some())
        });
    let manager = if workspace_root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if workspace_root.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    };
    match (manager, script) {
        ("npm", Some("test")) => "npm test".into(),
        ("npm", Some(script)) => format!("npm run {script}"),
        (_, Some(script)) => format!("{manager} {script}"),
        ("npm", None) => "npm test".into(),
        (_, None) => format!("{manager} test"),
    }
}

/// Comparable forms of the caller's `paths` for matching against checker
/// output: workspace-relative, forward slashes, lowercase, no leading `./`.
/// Absolute paths under the workspace are relativized so they compare equal to
/// the relative paths `tsc`/`cargo` print.
fn requested_path_needles(workspace_root: &Path, paths: &[String]) -> Vec<String> {
    let root = workspace_root
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    paths
        .iter()
        .map(|path| {
            let mut normalized = path.replace('\\', "/").to_lowercase();
            if !root.is_empty() && normalized.starts_with(&root) {
                normalized = normalized[root.len()..].trim_start_matches('/').to_string();
            }
            normalized.trim_start_matches("./").to_string()
        })
        .filter(|needle| !needle.is_empty())
        .collect()
}

/// Cap on singled-out diagnostic lines — enough to read every error in a
/// focused change without re-duplicating a whole failing build's output.
const MAX_REQUESTED_DIAGNOSTICS: usize = 50;

/// The diagnostic lines in `output` that reference any of the requested paths.
/// Substring match on the normalized line, so both `src/app.ts(3,1): error …`
/// (tsc) and `src\lib.rs:10:5: error …` (cargo, Windows separators) hit.
fn diagnostics_for_requested(output: &str, needles: &[String]) -> Vec<String> {
    output
        .lines()
        .filter(|line| {
            let normalized = line.replace('\\', "/").to_lowercase();
            needles.iter().any(|needle| normalized.contains(needle))
        })
        .take(MAX_REQUESTED_DIAGNOSTICS)
        .map(str::to_string)
        .collect()
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
    command: CheckCommand,
    cwd: String,
) -> Result<crate::commands::CommandOutput, String> {
    match command {
        CheckCommand::Shell(command) => {
            crate::commands::execute_command(command, Some(cwd), None, Some(CHECK_TIMEOUT_MS)).await
        }
        CheckCommand::Program { executable, args } => {
            let mut command = tokio::process::Command::new(executable);
            command.args(args).current_dir(cwd).kill_on_drop(true);

            // Without this, every checker pops a real console window on
            // Windows. `vanilla_javascript_checks` emits ONE spec per `.js`
            // file (up to 100), so a workspace with no root `tsconfig.json`
            // turned a single `read_lints` call into a burst of console
            // windows flashing across the screen. The sibling `Shell` branch
            // never had this bug — it routes through `execute_command`, which
            // has always set the flag.
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);

            let output = tokio::time::timeout(
                std::time::Duration::from_millis(CHECK_TIMEOUT_MS),
                command.output(),
            )
            .await
            .map_err(|_| format!("{executable} syntax check timed out after {CHECK_TIMEOUT_MS}ms"))?
            .map_err(|error| format!("failed to start {executable}: {error}"))?;
            Ok(crate::commands::CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
                success: output.status.success(),
                // The timeout branch above returns `Err`, so reaching here means
                // the checker exited on its own.
                timed_out: false,
            })
        }
    }
}

#[cfg(feature = "verify_only")]
async fn run_checker(
    _command: CheckCommand,
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
            thread_id: "s".into(),
            workspace_root,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
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
        assert!(ts[0].command.display().starts_with("pnpm exec tsc"));

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
        assert_eq!(
            fallback[0].command,
            CheckCommand::Shell("python -m compileall -q .".into())
        );

        fs::write(
            root.join("pyproject.toml"),
            "[tool.ruff]\nline-length = 100",
        )
        .expect("pyproject");
        let configured = select_checks(&root, &requested);
        assert_eq!(
            configured[0].command,
            CheckCommand::Shell("python -m ruff check .".into())
        );

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn vanilla_javascript_uses_node_without_shell_interpolation() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(root.join("src/app.js"), "const ready = true;").expect("js");

        let checks = select_checks(&root, &["src/app.js".into()]);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].name, "javascript-syntax");
        match &checks[0].command {
            CheckCommand::Program { executable, args } => {
                assert_eq!(*executable, "node");
                assert_eq!(args[0], "--check");
                assert_eq!(Path::new(&args[1]), Path::new("src/app.js"));
                assert!(!args[1].starts_with("\\\\?\\"));
            }
            other => panic!("expected direct program check, got {other:?}"),
        }

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn empty_paths_discovers_vanilla_javascript_without_scanning_dependencies() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("dependency");
        fs::write(root.join("src/app.js"), "const ready = true;").expect("app");
        fs::write(root.join("node_modules/pkg/index.js"), "broken(").expect("dependency js");

        let checks = select_checks(&root, &[]);
        assert_eq!(checks.len(), 1);
        match &checks[0].command {
            CheckCommand::Program { executable, args } => {
                assert_eq!(*executable, "node");
                assert_eq!(args[0], "--check");
                // Compare as paths, not substrings: `display()` renders each
                // arg with `{:?}`, which escapes the separators in a Windows
                // path (`src\\app.js`), so a literal `contains` can never
                // match there. `Path` equality is separator-agnostic.
                assert_eq!(Path::new(&args[1]), Path::new("src/app.js"));
                assert!(
                    !args[1].contains("node_modules"),
                    "dependencies must not be scanned: {}",
                    args[1]
                );
            }
            other => panic!("expected direct program check, got {other:?}"),
        }

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    /// The agent-reported gap: `tsc -b` is project-wide, so a change-scoped
    /// question ("did MY edit break anything?") needed a manual scan through
    /// pre-existing errors in untouched files. Requested-path diagnostics are
    /// singled out; unrelated ones stay in the raw output but not in the cut.
    #[test]
    fn diagnostics_are_partitioned_by_requested_path() {
        let root = PathBuf::from("E:/repo");
        let needles = requested_path_needles(
            &root,
            &[
                "src/hits/hits-page.tsx".into(),
                // Absolute form must relativize to compare with checker output.
                "E:\\repo\\src\\lib\\group.ts".into(),
            ],
        );
        let output = "\
src/hits/hits-page.tsx(12,5): error TS2345: bad argument\n\
src/bin-card.tsx(3,1): error TS2322: pre-existing\n\
src\\lib\\group.ts:7:9: error[E0308]: mismatched types\n\
src/bin-library-page.tsx(9,2): error TS2551: pre-existing\n";

        let hits = diagnostics_for_requested(output, &needles);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits[0].contains("hits-page.tsx"));
        assert!(hits[1].contains("group.ts"));
    }

    #[test]
    fn requested_diagnostics_are_bounded() {
        let needles = vec!["src/app.ts".to_string()];
        let output = "src/app.ts(1,1): error TS1: x\n".repeat(200);
        assert_eq!(
            diagnostics_for_requested(&output, &needles).len(),
            MAX_REQUESTED_DIAGNOSTICS
        );
    }

    #[test]
    fn html_css_guidance_points_to_configured_test_script() {
        let root = temp_workspace();
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"test":"node tests/harness.test.mjs"}}"#,
        )
        .expect("package");

        let message = validation_guidance(&root, &["index.html".into(), "src/app.css".into()]);
        assert!(message.contains("No HTML or CSS parser"));
        assert!(message.contains("`npm test`"));

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
