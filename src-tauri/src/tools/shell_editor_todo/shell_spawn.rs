//! `shell_spawn` — gated wrapper that hands a long-running command
//! off to [`crate::commands::execute_command_stream`] and returns the
//! request_id after a short startup confirmation window.
//!
//! Mirrors `src/tools/executors/shell-executors.ts::shellSpawnExecutor`.
//! The result content is the JSON `{ success, processId, command,
//! cwd, message }` shape that the existing TS executor produces, so
//! agent-prompt expectations don't change.
//!
//! The actual streaming happens off-task: the production
//! [`IdeEventSink::spawn_shell_stream`] invokes
//! `execute_command_stream` inside a `tokio::spawn`, so this tool's
//! `execute` returns once the sink confirms startup. Tests use the recording
//! sink to assert the request was queued correctly without starting a process.
//!
//! `requires_permission()` returns **true**.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::agent_safety::bash_validation::{classify_intent, ExecutionMode};
use crate::agent_safety::shell_validation::validate_for_shell;

use super::ide_event_sink::{IdeEventSink, ShellStreamRequest, SpawnOutcome};
use super::shell_execute::{
    map_bash_error, resolve_shell, resolve_working_directory, shell_argument_schema,
    shell_required_arguments, shell_tool_description,
};

/// The lifetime cap for this spawn: an explicit `timeout`, clamped, else the
/// effectively-unbounded default.
///
/// Extracted so the clamp is testable without spawning a real process — the
/// floor is the part worth pinning, since `timeout: 1` would otherwise kill a
/// dev server before it finished booting and report it as a startup failure.
fn resolve_background_timeout(input: &Value) -> u64 {
    input
        .get("timeout")
        .or_else(|| input.get("timeout_ms"))
        .and_then(Value::as_u64)
        .map(|value| value.clamp(MIN_BACKGROUND_TIMEOUT_MS, BACKGROUND_PROCESS_TIMEOUT_MS))
        .unwrap_or(BACKGROUND_PROCESS_TIMEOUT_MS)
}

const SHELL_EXECUTION_MODE: ExecutionMode = ExecutionMode::WorkspaceWrite;
/// Lifetime cap when the caller does not set one. Effectively "no cap" — a dev
/// server is expected to outlive the turn that started it and to be stopped by
/// `shell_kill`, not by a clock.
const BACKGROUND_PROCESS_TIMEOUT_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
/// Floor on an explicit `timeout`, so a stray `timeout: 1` cannot kill a
/// process before it has finished starting.
const MIN_BACKGROUND_TIMEOUT_MS: u64 = 1_000;

pub struct ShellSpawnTool {
    sink: Arc<dyn IdeEventSink>,
}

impl ShellSpawnTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }

    fn make_process_id() -> String {
        // Matches the TS `bg-{counter}-{epoch}` shape closely enough
        // for the audit log; we use `uuid` for the counter half so
        // multi-window aurora sessions can't collide.
        let id = uuid::Uuid::new_v4().simple().to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("bg-{}-{now}", &id[..8])
    }
}

#[async_trait]
impl ToolExecutor for ShellSpawnTool {
    fn name(&self) -> &str {
        "shell_spawn"
    }

    fn schema(&self) -> ToolSchema {
        let mut properties = json!({
            "command": {
                "type": "string",
                "description": "The shell command to spawn"
            },
            "cwd": {
                "type": "string",
                "description": "Working directory. Defaults to workspace root."
            },
            "name": {
                "type": "string",
                "description": "One-line title for this process, shown to the user above the \
                                composer while it runs — e.g. \"Vite dev server\", \"Jest watch\", \
                                \"Docker compose up\". Keep it under about 40 characters and \
                                describe what the process is, not the command line."
            },
            "timeout": {
                "type": "number",
                "description": "Hard lifetime cap in milliseconds — the process is killed after \
                                this long even if it is still healthy. Omit it for a dev server or \
                                watcher you intend to stop yourself with shell_kill. Set it when \
                                the run should be bounded, e.g. a log follower you only need for a \
                                few minutes."
            }
        });
        let shell_argument = shell_argument_schema();
        if let Some(shell) = shell_argument.clone() {
            properties
                .as_object_mut()
                .expect("object literal")
                .insert("shell".into(), shell);
        }

        ToolSchema {
            name: "shell_spawn".into(),
            description: shell_tool_description(
                "Spawn a long-running background process (e.g. dev server, watch process). \
                 Returns a process ID for later management with shell_list_processes and \
                 shell_kill.",
            ),
            input_schema: json!({
                "type": "object",
                "properties": properties,
                // The title is required because the user sees a card per
                // background process; without it they get a raw command line
                // and no way to tell two watchers apart. `shell` joins it for
                // the reason in `shell_required_arguments`.
                "required": shell_required_arguments(&["command", "name"], shell_argument.is_some()),
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

        // Validate against the shell this will actually run in — same policy
        // as `shell_execute`, including the workspace path stage when a
        // folder is open.
        let requested_shell = input.get("shell").and_then(Value::as_str);
        let resolved = crate::shell::resolve(requested_shell);
        let kind = resolved
            .as_ref()
            .map_or_else(|| crate::shell::resolve_kind(requested_shell), |r| r.kind);
        validate_for_shell(
            command,
            SHELL_EXECUTION_MODE,
            kind,
            ctx.workspace_root.as_deref(),
        )
        .map_err(map_bash_error)?;

        let intent = classify_intent(command).as_str();

        // Same rule as `shell_execute`: a background process must never inherit
        // Aurora's own working directory. A long-lived dev server started in the
        // wrong place is worse than one that refuses to start.
        let cwd = Some(resolve_working_directory(&input, ctx)?);

        let process_id = Self::make_process_id();
        // A single stable identity is returned, listed, and accepted by
        // shell_kill. The previous split bg-* and UUID identities made the
        // process invisible to later management calls.
        let request_id = process_id.clone();
        // Required by the schema, but a missing title should not cost a turn:
        // fall back to the leading words of the command so the card still says
        // something recognisable.
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| Some(title_from_command(command)));

        let timeout_ms = resolve_background_timeout(&input);

        let req = ShellStreamRequest {
            process_id: process_id.clone(),
            request_id: request_id.clone(),
            thread_id: ctx.thread_id.clone(),
            name: name.clone(),
            command: command.to_string(),
            cwd: cwd.clone(),
            // The same profile that was validated above — resolved once so a
            // spawned dev server can never end up in a different shell than
            // the one its command was checked against.
            shell: resolve_shell(requested_shell.map(str::to_string)),
            timeout_ms: Some(timeout_ms),
        };

        let outcome = self
            .sink
            .spawn_shell_stream(req)
            .await
            .map_err(|e| ToolError::Execution(format!("shell_spawn failed: {e}")))?;

        // A process that ended inside the startup window is not automatically
        // a failure. Exit 0 means the command did its job and finished — say
        // so, and hand back what it printed, rather than reporting a working
        // command as broken. A non-zero exit really did fail to start (a port
        // already in use, a missing binary), so that stays an error.
        if let SpawnOutcome::Exited(output) = outcome {
            if !output.success {
                let detail = [output.stderr.trim(), output.stdout.trim()]
                    .into_iter()
                    .find(|text| !text.is_empty())
                    .unwrap_or("the command produced no output");
                let detail: String = detail.chars().take(2_000).collect();
                return Err(ToolError::Execution(format!(
                    "'{command}' exited during startup with code {:?}: {detail}",
                    output.exit_code
                )));
            }
            return Ok(json!({
                "success": true,
                "completed": true,
                "processId": process_id,
                "command": command,
                "intent": intent,
                "cwd": cwd,
                "exitCode": output.exit_code,
                "stdout": output.stdout,
                "stderr": output.stderr,
                "message": "Command finished immediately (exit 0). Nothing is left running, so \
                            there is no process to list or stop.",
            })
            .to_string());
        }

        let output_file = match &outcome {
            SpawnOutcome::Running { output_file } => output_file.clone(),
            SpawnOutcome::Exited(_) => None,
        };

        Ok(json!({
            "success": true,
            "completed": false,
            "processId": process_id,
            "requestId": request_id,
            "name": name,
            "command": command,
            "intent": intent,
            "cwd": cwd,
            "timeoutMs": timeout_ms,
            // The live stream goes to the UI, which the model never sees. This
            // file is how it reads what the process actually printed.
            "outputFile": output_file,
            // The last line of the file is written by Aurora, not the process.
            // It is what tells a later reader whether the output stopped
            // because the run ended — and how — instead of leaving it to guess
            // between a crash, a clean exit, and someone hitting stop.
            "readOutputWith": output_file.as_ref().map(|_|
                "shell_read_output with this processId. Pass the returned nextStartLine as \
                 start_line on each later call to read only what is new, and set wait_ms to block \
                 until output arrives instead of polling. It reports `running: false` and quotes \
                 how the run ended, so you never have to guess between a crash, a clean exit, and \
                 a timeout."
            ),
            "shell": resolved.as_ref().map(|r| r.kind.id()),
            "shellNote": resolved.as_ref().and_then(|r| {
                r.substituted_from.as_ref().map(|requested| {
                    format!("'{requested}' is not configured; started in {} instead.", r.label)
                })
            }),
            "message": format!(
                "Background process started with ID: {process_id}. Its output is being written \
                 to outputFile — read that to see what it printed."
            ),
        })
        .to_string())
    }
}

/// A readable one-line title from a command, for when the model omits one.
fn title_from_command(command: &str) -> String {
    let flat = command.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 40 {
        return flat;
    }
    let clipped: String = flat.chars().take(39).collect();
    format!("{}…", clipped.trim_end())
}

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[test]
    fn no_timeout_means_effectively_unbounded() {
        assert_eq!(
            resolve_background_timeout(&json!({})),
            BACKGROUND_PROCESS_TIMEOUT_MS
        );
    }

    #[test]
    fn an_explicit_timeout_is_honoured() {
        assert_eq!(
            resolve_background_timeout(&json!({"timeout": 600_000})),
            600_000
        );
    }

    /// A one-millisecond cap would kill the process inside its own startup
    /// window and surface as "exited during startup" — a failure the model
    /// caused and could not diagnose.
    #[test]
    fn a_too_small_timeout_is_raised_to_the_floor() {
        assert_eq!(
            resolve_background_timeout(&json!({"timeout": 1})),
            MIN_BACKGROUND_TIMEOUT_MS
        );
    }

    #[test]
    fn an_absurd_timeout_is_capped_not_rejected() {
        assert_eq!(
            resolve_background_timeout(&json!({"timeout": u64::MAX})),
            BACKGROUND_PROCESS_TIMEOUT_MS
        );
    }

    #[test]
    fn schema_advertises_the_timeout_argument() {
        let tool = ShellSpawnTool::new(std::sync::Arc::new(
            crate::tools::shell_editor_todo::ide_event_sink::NoopIdeEventSink,
        ));
        let schema = tool.schema();
        assert!(
            schema.input_schema["properties"]["timeout"].is_object(),
            "the model cannot pass a timeout it is never told about"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::{
        NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink,
    };
    use tokio_util::sync::CancellationToken;

    /// No workspace — for the tests that assert a rejection happening BEFORE
    /// the working directory is resolved (command validation, empty command).
    fn ctx() -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// A context with a real workspace on disk. Required by anything that
    /// reaches execution: a background process must never inherit Aurora's own
    /// working directory, so `resolve_working_directory` refuses when there is
    /// no workspace and no valid `cwd`.
    fn ctx_in(root: &std::path::Path) -> ToolContext {
        ToolContext {
            workspace_root: Some(root.to_path_buf()),
            ..ctx()
        }
    }

    #[tokio::test]
    async fn requires_permission_is_true() {
        assert!(ShellSpawnTool::new(Arc::new(NoopIdeEventSink)).requires_permission());
    }

    #[tokio::test]
    async fn happy_path_records_stream_request() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let sink = RecordingIdeEventSink::new();
        let tool = ShellSpawnTool::new(sink.clone());
        let out = tool
            .execute(
                json!({"command": "echo hi", "cwd": "work"}),
                &ctx_in(tmp.path()),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["command"], json!("echo hi"));
        assert!(parsed["processId"]
            .as_str()
            .map(|s| s.starts_with("bg-"))
            .unwrap_or(false));

        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            RecordedEvent::ShellStream(req) => {
                assert_eq!(req.command, "echo hi");
                // A relative `cwd` is anchored to the workspace, not passed
                // through raw — the process must land somewhere real.
                assert_eq!(req.cwd.as_deref(), Some(work.to_string_lossy().as_ref()));
            }
            other => panic!("expected ShellStream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_validation_block() {
        let sink = RecordingIdeEventSink::new();
        let tool = ShellSpawnTool::new(sink.clone());
        let err = tool
            .execute(json!({"command": ":(){ :|:& };:"}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::PolicyViolation(_)));
        assert_eq!(sink.event_count(), 0, "must not have queued the stream");
    }

    #[tokio::test]
    async fn maps_sink_failure_to_execution_error() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = RecordingIdeEventSink::new();
        sink.fail_next("could not spawn");
        let tool = ShellSpawnTool::new(sink.clone());
        let err = tool
            .execute(json!({"command": "echo hi"}), &ctx_in(tmp.path()))
            .await
            .expect_err("must fail");
        match err {
            ToolError::Execution(msg) => assert!(msg.contains("could not spawn"), "got: {msg}"),
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    /// A background process is the worst thing to start in the wrong place —
    /// it outlives the turn, so nobody notices until much later.
    #[tokio::test]
    async fn refuses_to_spawn_with_no_workspace_and_no_cwd() {
        let sink = RecordingIdeEventSink::new();
        let tool = ShellSpawnTool::new(sink.clone());
        let err = tool
            .execute(json!({"command": "echo hi", "name": "probe"}), &ctx())
            .await
            .expect_err("must not inherit Aurora's cwd");
        assert!(matches!(err, ToolError::InvalidInput(_)), "{err:?}");
        assert_eq!(sink.event_count(), 0, "nothing may have been spawned");
    }

    #[tokio::test]
    async fn rejects_empty_command() {
        let tool = ShellSpawnTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"command": ""}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
