//! `shell_execute` — gated wrapper around
//! [`crate::commands::execute_command`].
//!
//! Mirrors `src/tools/executors/shell-executors.ts::shellExecuteExecutor`'s
//! inline mode (the terminal mode is a frontend-only render path —
//! the agent doesn't need a separate Rust executor for it; the
//! permission gate fires before the tool body so the frontend can
//! still elect to mirror the output through xterm).
//!
//! Output shape matches the TS executor (camelCase JSON) so existing
//! agent-prompt expectations don't change.
//!
//! `requires_permission()` returns **true** — every shell call goes
//! through the [`crate::tools::permissions::Permitter`] before this
//! body runs.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::agent_safety::bash_validation::{
    classify_intent, validate_command, validate_command_with_workspace, BashValidationError,
    ExecutionMode,
};

use super::ide_event_sink::IdeEventSink;

/// Default timeout — matches the TS `DEFAULT_SHELL_TIMEOUT_MS`.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Maximum timeout — matches the TS `MAX_SHELL_TIMEOUT_MS`.
const MAX_TIMEOUT_MS: u64 = 300_000;
/// Minimum timeout — matches the TS `MIN_SHELL_TIMEOUT_MS`.
const MIN_TIMEOUT_MS: u64 = 1_000;

/// Validation mode for shell tools — see module-level docs in
/// [`super`]. `WorkspaceWrite` is the closest match for the agent's
/// runtime mode (workspace-restricted writes allowed; system paths
/// warn; destructive patterns warn). The frontend's "danger / bypass"
/// mode is enforced one layer up by
/// [`crate::tools::permissions::SettingsAwarePermitter`] (the
/// permitter auto-approves before this validator runs), so we always
/// validate against `WorkspaceWrite` here.
const SHELL_EXECUTION_MODE: ExecutionMode = ExecutionMode::WorkspaceWrite;

pub struct ShellExecuteTool {
    /// Held for parity with the rest of the shell-tool family — the
    /// inline executor doesn't currently emit IDE events (the
    /// frontend renders the tool card from the JSON result), but
    /// `shell_spawn` does, and keeping the field here lets a future
    /// refactor route progress / streaming output through the same
    /// sink without changing the constructor signature.
    #[allow(dead_code)]
    sink: Arc<dyn IdeEventSink>,
}

impl ShellExecuteTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for ShellExecuteTool {
    fn name(&self) -> &str {
        "shell_execute"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_execute".into(),
            description: "Execute a shell command in the workspace directory. Returns stdout, \
                          stderr, and exit code. Use with caution as this can modify the \
                          system."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for the command. Defaults to workspace root."
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Timeout in milliseconds. Defaults to 30000 (30 seconds), maximum 300000 (5 minutes)."
                    },
                    "type": {
                        "type": "string",
                        "enum": ["inline", "terminal"],
                        "description": "Render mode. Inline (default) runs in the tool dropdown; terminal routes to the IDE terminal."
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let command = input
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`command` must be a string".into()))?;
        if command.trim().is_empty() {
            return Err(ToolError::InvalidInput("`command` must not be empty".into()));
        }

        // Prefer the workspace-aware validator when we have a folder
        // open: it adds the path-traversal stage (`../`, `~/`,
        // `$HOME`) that catches commands trying to escape the
        // workspace. Fall back to the workspace-free pipeline when
        // running outside a workspace (e.g. agent invoked from CLI
        // before opening a folder).
        if let Some(workspace) = ctx.workspace_root.as_ref() {
            validate_command_with_workspace(command, SHELL_EXECUTION_MODE, workspace)
                .map_err(map_bash_error)?;
        } else {
            validate_command(command, SHELL_EXECUTION_MODE).map_err(map_bash_error)?;
        }

        // Tag the result with the semantic intent so the audit log /
        // chat UI can render risk-aware affordances ("destructive",
        // "network", …) without re-parsing the command string in JS.
        let intent = classify_intent(command).as_str();

        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                ctx.workspace_root
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
            });

        let shell = input
            .get("shell")
            .and_then(Value::as_str)
            .map(str::to_string);

        let timeout_ms = input
            .get("timeout")
            .or_else(|| input.get("timeout_ms"))
            .and_then(Value::as_u64)
            .map(|v| v.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        // Race the underlying command against the cancel token so a
        // mid-flight cancel returns Cancelled (matches the agent_v2
        // contract's expectation that long-running tools yield to
        // cancellation).
        let command_string = command.to_string();
        let result = tokio::select! {
            biased;
            () = ctx.cancel_token.cancelled() => {
                return Err(ToolError::Cancelled);
            }
            res = run_command(command_string.clone(), cwd.clone(), shell.clone(), timeout_ms) => res,
        };

        match result {
            Ok(output) => Ok(json!({
                "success": output.success,
                "type": "inline",
                "command": command_string,
                "intent": intent,
                "cwd": cwd,
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exitCode": output.exit_code,
            })
            .to_string()),
            Err(err) => Ok(json!({
                "success": false,
                "type": "inline",
                "command": command_string,
                "intent": intent,
                "cwd": cwd,
                "error": err,
            })
            .to_string()),
        }
    }
}

/// Map [`BashValidationError`] onto [`ToolError::PolicyViolation`]
/// per Sub-D's contract. Both `Blocked` and `Warning` map to the same
/// variant — the permitter decides interactively whether to allow a
/// warning-level command.
pub fn map_bash_error(err: BashValidationError) -> ToolError {
    match err {
        BashValidationError::Blocked(reason) => {
            ToolError::PolicyViolation(format!("blocked: {reason}"))
        }
        BashValidationError::Warning(message) => {
            ToolError::PolicyViolation(format!("warning: {message}"))
        }
    }
}

#[cfg(not(feature = "verify_only"))]
async fn run_command(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: u64,
) -> Result<crate::commands::CommandOutput, String> {
    crate::commands::execute_command(command, cwd, shell, Some(timeout_ms)).await
}

// In the verify crate we never actually shell out — every test of
// shell_execute either returns at the validation gate or stubs the
// run via the cancel-token short-circuit. Keep a placeholder that
// always errors so the type-checker is happy even with the
// verify_only feature on.
#[cfg(feature = "verify_only")]
async fn run_command(
    _command: String,
    _cwd: Option<String>,
    _shell: Option<String>,
    _timeout_ms: u64,
) -> Result<crate::commands::CommandOutput, String> {
    Err("shell command execution disabled in verify_only".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::NoopIdeEventSink;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    fn tool() -> ShellExecuteTool {
        ShellExecuteTool::new(Arc::new(NoopIdeEventSink))
    }

    #[tokio::test]
    async fn requires_permission_returns_true() {
        assert!(tool().requires_permission());
    }

    #[tokio::test]
    async fn rejects_missing_command() {
        let err = tool()
            .execute(json!({}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn rejects_empty_command() {
        let err = tool()
            .execute(json!({"command": "   "}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn warns_on_destructive_command() {
        // `rm -rf /` triggers stage-3 destructive warning even in
        // WorkspaceWrite mode — the contract says map both Block and
        // Warn to PolicyViolation.
        let err = tool()
            .execute(json!({"command": "rm -rf /"}), &ctx())
            .await
            .expect_err("must fail");
        match err {
            ToolError::PolicyViolation(msg) => assert!(msg.contains("warning") || msg.contains("destructive") || msg.contains("root"), "got: {msg}"),
            other => panic!("expected PolicyViolation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn schema_advertises_command_required() {
        let schema = tool().schema();
        let req = schema
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .expect("required array");
        assert!(req.iter().any(|v| v.as_str() == Some("command")));
    }

    #[tokio::test]
    async fn pre_cancelled_context_short_circuits() {
        let c = ctx();
        c.cancel_token.cancel();
        let err = tool()
            .execute(json!({"command": "ls"}), &c)
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
    }

    #[test]
    fn map_bash_error_handles_blocked_and_warning() {
        let blocked = map_bash_error(BashValidationError::Blocked("bad".into()));
        match blocked {
            ToolError::PolicyViolation(m) => assert!(m.starts_with("blocked:")),
            other => panic!("expected PolicyViolation, got {other:?}"),
        }
        let warned = map_bash_error(BashValidationError::Warning("watch out".into()));
        match warned {
            ToolError::PolicyViolation(m) => assert!(m.starts_with("warning:")),
            other => panic!("expected PolicyViolation, got {other:?}"),
        }
    }
}
