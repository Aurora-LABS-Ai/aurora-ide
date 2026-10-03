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
use crate::agent_safety::bash_validation::{classify_intent, BashValidationError, ExecutionMode};
use crate::agent_safety::shell_validation::validate_for_shell_at;
use crate::tools::timeout::TimeoutPolicy;

use super::ide_event_sink::{IdeEventSink, ShellStreamRequest};

/// Default timeout when the caller does not pass one.
///
/// Was 30s, which is under the time a cold `cargo check` or `tsc -b` needs on
/// this repo — so the common case was a timeout that looked like a broken
/// command. Two minutes covers ordinary build and test commands; anything
/// genuinely long belongs in `shell_spawn`.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Maximum timeout a caller may ask for.
///
/// Was 5 minutes, so a legitimately long test suite could not be waited out at
/// all: the model's only options were a command it knew would be killed, or
/// backgrounding work it needed the result of. Half an hour is enough for a
/// real suite while still bounding a runaway process.
const MAX_TIMEOUT_MS: u64 = 1_800_000;
/// Minimum timeout — matches the TS `MIN_SHELL_TIMEOUT_MS`.
const MIN_TIMEOUT_MS: u64 = 1_000;

/// How the `timeout` argument is read. The numbers are this tool's; the reading
/// of them is [`crate::tools::timeout`]'s, so every tool that takes a timeout
/// takes it the same way.
///
/// The policy is used for its [`TimeoutPolicy::resolve`] only. This tool is NOT
/// wrapped by `TimeoutGuardedExecutor` and deliberately declares no
/// `timeout_policy()`: an outside clock abandons the call, while this one kills
/// the process and hands back everything it printed first. Partial output from
/// a build that ran for two minutes is worth more than a sentence saying it did.
const TIMEOUT: TimeoutPolicy = TimeoutPolicy::new(
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "Re-run with a larger `timeout`, or use shell_spawn for work with no natural end.",
);

/// Validation mode for shell tools — see module-level docs in
/// [`super`]. `WorkspaceWrite` is the closest match for the agent's
/// runtime mode (workspace-restricted writes allowed; system paths
/// warn; destructive patterns warn). Full access skips this pipeline entirely.
const SHELL_EXECUTION_MODE: ExecutionMode = ExecutionMode::WorkspaceWrite;

pub struct ShellExecuteTool {
    /// Routes execution through [`IdeEventSink::run_shell_stream`] so output
    /// is emitted on `shell-stream-{tool_call_id}` as it arrives. The tool
    /// card renders the command live — the way a terminal does — instead of
    /// staying empty until the process exits.
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
        let mut properties = json!({
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
                "description": "Timeout in milliseconds. Defaults to 120000 (2 minutes), maximum 1800000 (30 minutes). Set this yourself whenever you expect the command to be slow — a build, a full test suite, an install. If the timeout is hit the process is killed and you get whatever it printed first, with timedOut: true. For work with no natural end (dev servers, watchers) use shell_spawn instead of a long timeout."
            }
            // No `type: inline|terminal`. It advertised routing a command to
            // the IDE terminal, but the executor never read it and the Agent
            // Window has no editor terminal to route to — the model could only
            // ever waste a turn discovering that both values behave alike.
            // Output now streams live into the tool card either way.
        });
        let shell_argument = shell_argument_schema();
        if let Some(shell) = shell_argument.clone() {
            properties
                .as_object_mut()
                .expect("object literal")
                .insert("shell".into(), shell);
        }

        ToolSchema {
            name: "shell_execute".into(),
            description: shell_tool_description(
                "Run a command in a shell, exactly as if typed at its prompt, and return what it \
                 printed with its exit code. Runs in the workspace root unless `cwd` says \
                 otherwise. It can change files and the system, so use it with care.",
            ),
            input_schema: json!({
                "type": "object",
                "properties": properties,
                "required": shell_required_arguments(&["command"], shell_argument.is_some()),
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
            return Err(ToolError::InvalidInput(
                "`command` must not be empty".into(),
            ));
        }

        let requested_shell = input.get("shell").and_then(Value::as_str);
        // Validate against the shell the command will *actually* run in.
        // A PowerShell `Remove-Item -Recurse -Force` means nothing to the
        // POSIX validator, so the kind has to be resolved before the gate.
        let resolved = crate::shell::resolve(requested_shell);
        let kind = resolved
            .as_ref()
            .map_or_else(|| crate::shell::resolve_kind(requested_shell), |r| r.kind);

        validate_shell_command(command, &input, ctx, kind)?;

        // Tag the result with the semantic intent so the audit log /
        // chat UI can render risk-aware affordances ("destructive",
        // "network", …) without re-parsing the command string in JS.
        let intent = classify_intent(command).as_str();

        let cwd = Some(resolve_working_directory(&input, ctx)?);

        let shell = resolve_shell(requested_shell.map(str::to_string));

        let timeout_ms = TIMEOUT.resolve(&input);

        // The stream id is the tool call id, so the card that renders this
        // call is exactly the surface that receives its output.
        let request = ShellStreamRequest {
            process_id: ctx.tool_call_id.clone(),
            request_id: ctx.tool_call_id.clone(),
            thread_id: ctx.thread_id.clone(),
            name: None,
            command: command.to_string(),
            cwd: cwd.clone(),
            shell,
            timeout_ms: Some(timeout_ms),
        };

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
            res = self.sink.run_shell_stream(request) => res,
        };

        // Report a shell substitution instead of letting the model believe
        // its command ran under the shell it named.
        let shell_note = resolved.as_ref().and_then(|r| {
            r.substituted_from.as_ref().map(|requested| {
                format!(
                    "'{requested}' is not configured; ran in {} instead. Registered shells are \
                     managed in Settings → Tools.",
                    r.label
                )
            })
        });

        match result {
            // The user pressed "Run in background" while this was running. The
            // turn gets its answer NOW so the model can carry on, and the
            // process carries on too — under `processId`, with its output
            // still being written to `outputFile`.
            //
            // Its own branch rather than a flag on the ordinary result: every
            // field below describes how a command ENDED, and this one has not
            // ended. Reusing that shape would have meant `success: false,
            // exitCode: null` on a healthy process, which reads as a failure.
            Ok(output) if output.detached => Ok(json!({
                "success": true,
                "type": "inline",
                "detached": true,
                "command": command_string,
                "intent": intent,
                "cwd": cwd,
                "shell": resolved.as_ref().map(|r| r.kind.id()),
                "shellNote": shell_note,
                "processId": ctx.tool_call_id,
                "outputFile": output.output_file,
                // What it had printed by the time it was handed over — the tail
                // of the log, so a long build shows its most recent lines.
                "stdout": output.stdout,
                "note": format!(
                    "Still running. The user moved this command to the background, so it was not \
                     waited for and the output above is only what it had printed by then — it is \
                     not the result. The process id is {}. When it exits, Aurora tells you with \
                     its exit code, so do not poll it or wait on it to learn whether it finished. \
                     Read what it has printed since with shell_read_output only when you need \
                     that output now, and stop it with shell_kill. Do not re-run the command \
                     because this result has no exit code; it does not have one yet.",
                    ctx.tool_call_id
                ),
            })
            .to_string()),
            Ok(output) => Ok(json!({
                "success": output.success,
                "type": "inline",
                "command": command_string,
                "intent": intent,
                "cwd": cwd,
                "shell": resolved.as_ref().map(|r| r.kind.id()),
                "shellNote": shell_note,
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exitCode": output.exit_code,
                // A timeout is not a failing command, and the model cannot tell
                // the two apart from stdout alone. Both the flag and the note
                // are here so it stops "fixing" commands that only ran long.
                "timedOut": output.timed_out,
                "timeoutMs": timeout_ms,
                // A survivor is a fact the model must hear NOW: the next thing
                // it usually does is probe the thing it just started, and
                // without this line the only story it can invent is "Aurora
                // killed my process" — observed verbatim in a real session.
                "leftRunning": output.left_running,
                "note": if output.timed_out {
                    Some(format!(
                        "Killed after {timeout_ms}ms — the command had not finished. The output \
                         above is only what it printed before being stopped, so treat it as \
                         partial, not as the result. Re-run with a larger `timeout` if it just \
                         needs longer, or start it with shell_spawn and follow it with \
                         shell_read_output if it has no natural end."
                    ))
                } else if output.left_running {
                    let who = if output.survivors.is_empty() {
                        "a process it started is still running".to_string()
                    } else {
                        format!(
                            "it left running: {}",
                            output.survivors.join(", ")
                        )
                    };
                    Some(format!(
                        "The command finished, and {who}. Aurora is not tracking that — nothing \
                         more from it will appear here, and there is no processId to read or \
                         stop. If the running process is the point (a server, a watcher), start \
                         it with shell_spawn instead so it gets a processId and a readable \
                         output file."
                    ))
                } else {
                    None
                },
            })
            .to_string()),
            Err(err) => Ok(json!({
                "success": false,
                "type": "inline",
                "command": command_string,
                "intent": intent,
                "cwd": cwd,
                "shell": resolved.as_ref().map(|r| r.kind.id()),
                "shellNote": shell_note,
                "error": err,
            })
            .to_string()),
        }
    }
}

/// Shared by foreground and background execution so access cannot differ.
pub(super) fn validate_shell_command(
    command: &str,
    input: &Value,
    ctx: &ToolContext,
    kind: crate::shell::ShellKind,
) -> Result<(), ToolError> {
    if ctx.workspace_access.lifts_boundary() {
        return Ok(());
    }
    let validation_cwd = input.get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            ctx.workspace_root.as_deref()
                .unwrap_or(std::path::Path::new(""))
                .join(path)
        });
    validate_for_shell_at(
        command,
        SHELL_EXECUTION_MODE,
        kind,
        ctx.workspace_root.as_deref(),
        validation_cwd.as_deref().or(ctx.workspace_root.as_deref()),
    )
    .map_err(map_bash_error)
}

/// The `shell` argument, enumerated from the shells the user left enabled.
///
/// Emitted whenever the registry knows of at least ONE usable shell — including
/// the single-shell case. It previously required two, which meant that on a
/// one-shell machine the parameter vanished entirely and the model could not
/// state where its command ran even if it wanted to. The enum is the honest
/// answer either way: one option is still an answer.
///
/// Returns `None` only before the first scan, when the registry is empty and we
/// genuinely do not know what exists.
pub(crate) fn shell_argument_schema() -> Option<Value> {
    let kinds = crate::shell::available_kinds();
    if kinds.is_empty() {
        return None;
    }
    let ids: Vec<&str> = kinds.iter().map(|kind| kind.id()).collect();
    Some(json!({
        "type": "string",
        "enum": ids,
        "description": "The shell this command is written for. Required — command syntax is not \
                        portable between these, so pick the one whose syntax you used."
    }))
}

/// The directory a shell command runs in — explicit `cwd`, else the workspace
/// root, and an error if neither exists.
///
/// It must never be `None`. `build_shell_command` only calls `current_dir` when
/// it has a path, so a `None` here silently hands the child **Aurora's own**
/// working directory — the app install dir, or `C:\Windows\System32` depending
/// on how the app was launched. A relative command then runs somewhere nobody
/// chose: `dir /s /b *.ts` walking from a drive root returns
/// `Access denied - \` and looks like a Windows permissions problem rather than
/// a harness bug, which is exactly how it was first misdiagnosed.
///
/// A non-existent path is rejected here too, so a typo'd `cwd` says so instead
/// of surfacing as an opaque spawn failure.
pub(crate) fn resolve_working_directory(
    input: &Value,
    ctx: &ToolContext,
) -> Result<String, ToolError> {
    if let Some(requested) = input
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = std::path::Path::new(requested);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            match ctx.workspace_root.as_ref() {
                Some(root) => root.join(path),
                None => path.to_path_buf(),
            }
        };
        if !resolved.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "`cwd` '{requested}' is not a directory. Pass an existing path, or omit `cwd` to \
                 run in the workspace root."
            )));
        }
        return Ok(resolved.to_string_lossy().to_string());
    }

    ctx.workspace_root
        .as_ref()
        .map(|root| root.to_string_lossy().to_string())
        .ok_or_else(|| {
            ToolError::InvalidInput(
                "No workspace is open, so there is no directory to run this command in. Open a \
                 folder in Aurora, or pass an absolute `cwd`."
                    .into(),
            )
        })
}

/// A shell tool's `required` list: its own mandatory arguments, plus `shell`
/// whenever the registry knows what shells exist.
///
/// Making `shell` required is the point of the change: a command is written in
/// exactly one shell's syntax, so which shell that is belongs to the model that
/// wrote it, not to a setting. Before this, `shell` was optional and Aurora
/// silently picked, which is how a POSIX one-liner could end up in PowerShell.
///
/// It stays optional in the one case where requiring it would be a lie — an
/// unscanned registry, where there is no enum to choose from.
pub(crate) fn shell_required_arguments(base: &[&str], has_shell_argument: bool) -> Value {
    let mut required: Vec<&str> = base.to_vec();
    if has_shell_argument {
        required.push("shell");
    }
    json!(required)
}

/// Append the live shell inventory to a tool description, so the guidance the
/// model reads always matches what is installed.
/// The environment Aurora composes for a child shell, stated to the model.
///
/// The shell is NOT a plain inherited terminal, and a model that assumes it is
/// will reach a wrong conclusion the first time something depends on the
/// environment. On 2026-09-04 that happened concretely: a test asserting
/// `PYTHONUNBUFFERED=1` is added to a child's overlay passed from an ordinary
/// terminal and failed from here — because Aurora had already set it, so
/// correctly there was nothing left to add. The agent had no way to know that
/// and reported the failure as a pre-existing bug in the repository.
///
/// One sentence in the tool's description rather than a field on every result:
/// it is true for the whole session and belongs in the cached prefix, and a
/// per-call line about the environment would be noise on the hundreds of calls
/// where nothing depends on it.
const SHELL_ENVIRONMENT_NOTE: &str = " The shell is started by Aurora, not inherited from a \
     terminal: PATH is merged with what the registry defines right now (so a tool installed after \
     login is on PATH without a sign-out), and PYTHONUNBUFFERED=1 is set so a script's output \
     streams instead of arriving all at once when it exits. If something you run reads the \
     environment, read it here first rather than assuming a bare shell.";

pub(crate) fn shell_tool_description(base: &str) -> String {
    match crate::shell::model_facing_summary() {
        Some(summary) => format!("{base} {summary}{SHELL_ENVIRONMENT_NOTE}"),
        None => format!(
            "{base} Runs in a POSIX shell (bash) when one is available, otherwise the platform \
             default — prefer POSIX commands (ls, cat, rm, &&, |, single-quote \
             quoting).{SHELL_ENVIRONMENT_NOTE}"
        ),
    }
}

/// Pick the shell for an agent command.
///
/// Resolution happens once, here, and the result is passed downstream as a
/// concrete **profile id** — so the shell that was validated is provably the
/// shell that runs, with no second resolution that could pick differently.
/// Falls back to the pre-registry behaviour (Git Bash when installed) only
/// while the registry is still empty. Shared with `shell_spawn`.
#[must_use]
pub(crate) fn resolve_shell(requested: Option<String>) -> Option<String> {
    if let Some(resolved) = crate::shell::resolve(requested.as_deref()) {
        return Some(resolved.profile_id);
    }
    if requested.is_some() {
        return requested;
    }
    #[cfg(target_os = "windows")]
    {
        if crate::commands::find_git_bash().is_some() {
            return Some("bash".to_string());
        }
    }
    None
}

/// Map [`BashValidationError`] onto [`ToolError::PolicyViolation`].
///
/// Both severities refuse the call. This used to render the softer one as
/// `policy violation: warning: …`, which described an intention rather than
/// what happened: the doc here said "the permitter decides interactively
/// whether to allow a warning-level command", and no permitter was ever
/// consulted — `PolicyViolation` appears nowhere in `tools::permissions`, and
/// [`super::shell_execute`] returns this error before any gate runs.
///
/// Measured 2026-09-19: eight refusals in three days arrived under the word
/// "warning", every one of them final. A model reading "warning" about a
/// command that did not run is being told something untrue about its own call,
/// and the recovery it picks follows the word, not the outcome.
///
/// The severities still differ and the text still says which is which — the
/// rules behind `Warning` are heuristics about paths and destructive shapes,
/// and a caller that knows one fired can argue with it. What neither of them
/// may do is imply the command ran.
pub fn map_bash_error(err: BashValidationError) -> ToolError {
    match err {
        BashValidationError::Blocked(reason) => {
            ToolError::PolicyViolation(format!("blocked: {reason}"))
        }
        BashValidationError::Warning(message) => {
            ToolError::PolicyViolation(format!("blocked by a safety rule: {message}"))
        }
    }
}

// Execution now goes through `IdeEventSink::run_shell_stream` so the output
// streams to the tool card while it runs. The sink implementations own the
// platform detail: production streams through Tauri, the no-op sink runs the
// command unstreamed, and the verify crate refuses to shell out at all.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::NoopIdeEventSink;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    fn tool() -> ShellExecuteTool {
        ShellExecuteTool::new(Arc::new(NoopIdeEventSink))
    }

    #[tokio::test]
    async fn full_access_bypasses_guards_for_both_shell_tools_and_keeps_cancellation() {
        use crate::agent_runtime::tool_executor::WorkspaceAccess;
        use super::super::ide_event_sink::RecordingIdeEventSink;
        use super::super::shell_spawn::ShellSpawnTool;
        let sink = RecordingIdeEventSink::new();
        let dir = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(dir.path().to_path_buf());
        let tools: Vec<Box<dyn ToolExecutor>> = vec![
            Box::new(ShellExecuteTool::new(sink.clone())),
            Box::new(ShellSpawnTool::new(sink.clone())),
        ];
        // The recording sink never runs this command; it records dispatch only.
        let input = json!({"command": "rm -rf /", "shell": "bash", "name": "guard test"});
        for tool in tools {
            for access in [WorkspaceAccess::Workspace, WorkspaceAccess::Read] {
                context.workspace_access = access;
                assert!(matches!(
                    tool.execute(input.clone(), &context).await,
                    Err(ToolError::PolicyViolation(_))
                ));
            }
            context.workspace_access = WorkspaceAccess::Full;
            assert!(tool.execute(input.clone(), &context).await.is_ok());
            context.cancel_token.cancel();
            assert_eq!(
                tool.execute(input.clone(), &context).await,
                Err(ToolError::Cancelled)
            );
            context.cancel_token = CancellationToken::new();
        }
        assert_eq!(sink.event_count(), 2);
    }

    #[tokio::test]
    async fn validates_paths_from_explicit_cwd_for_both_shell_tools() {
        use super::super::ide_event_sink::RecordingIdeEventSink;
        use super::super::shell_spawn::ShellSpawnTool;
        let sink = RecordingIdeEventSink::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("child")).unwrap();
        let mut context = ctx();
        context.workspace_root = Some(dir.path().to_path_buf());
        for tool in [
            Box::new(ShellExecuteTool::new(sink.clone())) as Box<dyn ToolExecutor>,
            Box::new(ShellSpawnTool::new(sink.clone())),
        ] {
            let input = json!({"command": "cat ../file", "cwd": "child", "shell": "bash", "name": "read"});
            assert!(tool.execute(input, &context).await.is_ok());
            let input = json!({"command": "cat ../../file", "cwd": "child", "shell": "bash", "name": "read"});
            assert!(matches!(
                tool.execute(input, &context).await,
                Err(ToolError::PolicyViolation(_))
            ));
        }
        assert_eq!(sink.event_count(), 2);
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
            ToolError::PolicyViolation(msg) => assert!(
                msg.contains("warning") || msg.contains("destructive") || msg.contains("root"),
                "got: {msg}"
            ),
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

    /// The bug this guard exists for: with no workspace and no `cwd`, the
    /// child used to inherit Aurora's own working directory and run somewhere
    /// nobody chose. Refusing is the only honest answer.
    #[tokio::test]
    async fn refuses_to_run_with_no_workspace_and_no_cwd() {
        let err = tool()
            .execute(json!({ "command": "ls" }), &ctx())
            .await
            .expect_err("must not inherit Aurora's cwd");
        match err {
            ToolError::InvalidInput(message) => {
                assert!(message.contains("No workspace is open"), "{message}");
                assert!(message.contains("cwd"), "must name the way out: {message}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_a_cwd_that_is_not_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());
        let err = tool()
            .execute(
                json!({ "command": "ls", "cwd": "does/not/exist" }),
                &context,
            )
            .await
            .expect_err("a typo'd cwd must be named, not spawned into");
        assert!(matches!(err, ToolError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn workspace_root_is_the_default_working_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());
        let resolved = resolve_working_directory(&json!({}), &context).expect("resolves");
        assert_eq!(resolved, tmp.path().to_string_lossy());
    }

    #[test]
    fn a_relative_cwd_anchors_to_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("packages/api")).unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());
        let resolved =
            resolve_working_directory(&json!({ "cwd": "packages/api" }), &context).expect("ok");
        assert_eq!(resolved, tmp.path().join("packages/api").to_string_lossy());
    }

    /// Sink that reports a run killed by the timeout, with partial output —
    /// exactly the shape `execute_command_stream` returns in that case.
    struct TimedOutSink;

    #[async_trait]
    impl crate::tools::shell_editor_todo::ide_event_sink::IdeEventSink for TimedOutSink {
        fn emit_editor_open(
            &self,
            _path: &str,
            _line: Option<u64>,
            _column: Option<u64>,
        ) -> Result<(), String> {
            Ok(())
        }
        fn emit_todo_write(&self, _thread_id: &str, _todos: &Value) -> Result<(), String> {
            Ok(())
        }
        fn emit_plan_changed(
            &self,
            _payload: &crate::tools::shell_editor_todo::PlanChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
        async fn spawn_shell_stream(
            &self,
            _req: ShellStreamRequest,
        ) -> Result<crate::tools::shell_editor_todo::ide_event_sink::SpawnOutcome, String> {
            Err("not used".into())
        }
        async fn run_shell_stream(
            &self,
            _req: ShellStreamRequest,
        ) -> Result<crate::tools::shell_editor_todo::ide_event_sink::ShellRunOutput, String>
        {
            Ok(
                crate::tools::shell_editor_todo::ide_event_sink::ShellRunOutput {
                    stdout: "compiling...\n".into(),
                    stderr: String::new(),
                    exit_code: None,
                    success: false,
                    timed_out: true,
                    left_running: false,
                    survivors: Vec::new(),
                    detached: false,
                    output_file: None,
                },
            )
        }
        fn emit_file_changed(
            &self,
            _payload: &crate::tools::shell_editor_todo::FileChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// The regression this guards: a timeout used to arrive as
    /// `exitCode: 1, success: false` with no other signal, so the model read a
    /// slow command as a broken one and "fixed" working code.
    #[tokio::test]
    async fn a_timeout_is_reported_as_a_timeout_not_a_failed_command() {
        let tmp = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());

        let out = ShellExecuteTool::new(Arc::new(TimedOutSink))
            .execute(json!({"command": "cargo test", "timeout": 5_000}), &context)
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["timedOut"], json!(true));
        assert_eq!(parsed["timeoutMs"], json!(5_000));
        assert_eq!(parsed["exitCode"], Value::Null, "it never reported one");
        assert_eq!(
            parsed["stdout"],
            json!("compiling...\n"),
            "keep partial output"
        );

        let note = parsed["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("partial"),
            "must not read as a result: {note}"
        );
        assert!(
            note.contains("shell_spawn"),
            "must name the way out: {note}"
        );
    }

    /// Sink that reports the run being handed to the background mid-flight —
    /// what `run_shell_stream` returns after the card's button is pressed.
    struct DetachedSink;

    #[async_trait]
    impl crate::tools::shell_editor_todo::ide_event_sink::IdeEventSink for DetachedSink {
        fn emit_editor_open(
            &self,
            _path: &str,
            _line: Option<u64>,
            _column: Option<u64>,
        ) -> Result<(), String> {
            Ok(())
        }
        fn emit_todo_write(&self, _thread_id: &str, _todos: &Value) -> Result<(), String> {
            Ok(())
        }
        fn emit_plan_changed(
            &self,
            _payload: &crate::tools::shell_editor_todo::PlanChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
        async fn spawn_shell_stream(
            &self,
            _req: ShellStreamRequest,
        ) -> Result<crate::tools::shell_editor_todo::ide_event_sink::SpawnOutcome, String> {
            Err("not used".into())
        }
        async fn run_shell_stream(
            &self,
            _req: ShellStreamRequest,
        ) -> Result<crate::tools::shell_editor_todo::ide_event_sink::ShellRunOutput, String>
        {
            Ok(
                crate::tools::shell_editor_todo::ide_event_sink::ShellRunOutput {
                    stdout: "vite building for production...\n".into(),
                    stderr: String::new(),
                    exit_code: None,
                    success: false,
                    timed_out: false,
                    left_running: true,
                    survivors: Vec::new(),
                    detached: true,
                    output_file: Some("E:/logs/tool-call-1.log".into()),
                },
            )
        }
        fn emit_file_changed(
            &self,
            _payload: &crate::tools::shell_editor_todo::FileChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// "Run in background" must answer the model with something it can act on:
    /// a success (nothing went wrong), an explicit "not finished", the id to
    /// follow it by, and no exit code pretending to be an outcome.
    #[tokio::test]
    async fn a_detached_run_reports_a_live_process_not_a_result() {
        let tmp = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());

        let out = ShellExecuteTool::new(Arc::new(DetachedSink))
            .execute(json!({"command": "pnpm build"}), &context)
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["detached"], json!(true));
        // Nothing failed, so the call did not fail. A `success: false` here
        // would have the model "recover" from a healthy build.
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["processId"], json!(context.tool_call_id));
        assert_eq!(parsed["outputFile"], json!("E:/logs/tool-call-1.log"));
        assert_eq!(
            parsed["exitCode"],
            Value::Null,
            "there is no exit code yet, and zero would claim it succeeded"
        );
        assert_eq!(
            parsed["stdout"],
            json!("vite building for production...\n"),
            "what it printed before the hand-off is kept"
        );

        let note = parsed["note"].as_str().unwrap_or_default();
        assert!(note.contains("Still running"), "{note}");
        assert!(note.contains("shell_read_output"), "names how to follow it: {note}");
        assert!(note.contains("shell_kill"), "names how to stop it: {note}");
        assert!(
            note.contains(&context.tool_call_id),
            "carries the id in prose too, since that is what the model quotes: {note}"
        );
    }

    #[tokio::test]
    async fn a_normal_run_carries_no_timeout_note() {
        let tmp = tempfile::tempdir().unwrap();
        let mut context = ctx();
        context.workspace_root = Some(tmp.path().to_path_buf());

        let out = ShellExecuteTool::new(Arc::new(NoopIdeEventSink))
            .execute(json!({"command": "echo hi"}), &context)
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["timedOut"], json!(false));
        assert_eq!(parsed["note"], Value::Null);
        // The default the schema advertises must be the default applied.
        assert_eq!(parsed["timeoutMs"], json!(DEFAULT_TIMEOUT_MS));
    }

    #[test]
    fn an_over_large_timeout_is_clamped_to_the_ceiling() {
        let clamped = 9_999_999u64.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        assert_eq!(clamped, MAX_TIMEOUT_MS);
        assert_eq!(MAX_TIMEOUT_MS, 1_800_000, "30 minutes");
    }

    /// Both severities refuse, so both have to SAY they refused. The softer one
    /// used to open with "warning:", which reads as advisory about a command
    /// that never ran — see `map_bash_error` for the eight refusals that
    /// arrived under that word in three days.
    #[test]
    fn map_bash_error_says_blocked_for_both_severities() {
        let blocked = map_bash_error(BashValidationError::Blocked("bad".into()));
        match blocked {
            ToolError::PolicyViolation(m) => assert!(m.starts_with("blocked:"), "got {m}"),
            other => panic!("expected PolicyViolation, got {other:?}"),
        }
        let warned = map_bash_error(BashValidationError::Warning("watch out".into()));
        match warned {
            ToolError::PolicyViolation(m) => {
                assert!(m.starts_with("blocked"), "a refusal must say so: {m}");
                assert!(
                    !m.starts_with("warning:"),
                    "\"warning\" describes an intention that was never wired: {m}"
                );
                assert!(m.contains("watch out"), "and still carries the reason: {m}");
            }
            other => panic!("expected PolicyViolation, got {other:?}"),
        }
    }
}
