//! The production [`IdeEventSink`]: what the native tools tell the host.
//!
//! The fire-and-forget editor/todo tools (`editor_open_file`, the task tools)
//! go out as named events on the host's [`EventSink`]; the desktop app passes
//! its `AppHandle`, so the windows get them, and a host with no window passes
//! whatever forwards events to its own clients. `shell_execute` and
//! `shell_spawn` run through [`crate::process::streams`], the same runner the
//! window's `execute_command_stream` command uses, streaming as
//! `shell-stream-{request_id}`.

use std::sync::{Arc, Weak};

use super::AgentRegistry;
use crate::host_events::{EventSink, Events};
use crate::logging;
use crate::process::streams;
use crate::tools::shell_editor_todo::ide_event_sink::{
    PlanChangedPayload, ShellRunOutput, ShellStreamRequest, SpawnOutcome, PLAN_CHANGED_EVENT,
};
use crate::tools::shell_editor_todo::{FileChangedPayload, IdeEventSink, FILE_CHANGED_EVENT};

pub struct HostIdeEventSink {
    events: Events,
    /// Where a thread's folder is found. Weak: the registry owns the tool
    /// registry that owns this sink.
    registry: Weak<AgentRegistry>,
}

impl HostIdeEventSink {
    pub fn new(events: Events, registry: &Arc<AgentRegistry>) -> Self {
        Self {
            events,
            registry: Arc::downgrade(registry),
        }
    }

    fn emit_payload<T: serde::Serialize>(&self, channel: &str, payload: T) -> Result<(), String> {
        <dyn EventSink>::emit(self.events.as_ref(), channel, payload)
    }

    /// Where a background process's output is mirrored.
    ///
    /// Lives in the thread's `tool-results` directory, so it is cleaned up
    /// with the thread and sits alongside spilled tool output. `None` when the
    /// registry is gone or the directory cannot be created — the process
    /// still runs and still streams to the UI, the agent just cannot read it
    /// back.
    fn resolve_background_log_path(&self, thread_id: &str, process_id: &str) -> Option<String> {
        let registry = self.registry.upgrade()?;
        let store = registry
            .require_store_for_thread(thread_id)
            .map_err(|e| {
                logging::log_warn(
                    "shell.background",
                    &format!("cannot locate conversation {thread_id}: {e}"),
                );
            })
            .ok()?;
        let dir = store.tool_results_dir(thread_id);
        std::fs::create_dir_all(&dir).ok()?;

        // Process ids are Aurora-generated (`bg-<hex>-<epoch>`), but keep the
        // same defensive filter used for spilled output.
        let stem: String = process_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(64)
            .collect();
        let path = dir.join(format!("{stem}.log"));
        Some(
            dunce::canonicalize(&path)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string(),
        )
    }
}

#[async_trait::async_trait]
impl IdeEventSink for HostIdeEventSink {
    fn emit_editor_open(
        &self,
        path: &str,
        line: Option<u64>,
        column: Option<u64>,
    ) -> Result<(), String> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            path: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            line: Option<u64>,
            #[serde(skip_serializing_if = "Option::is_none")]
            column: Option<u64>,
        }
        self.emit_payload("agent_editor_open", Payload { path, line, column })
    }

    fn emit_todo_write(&self, thread_id: &str, todos: &serde_json::Value) -> Result<(), String> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            thread_id: &'a str,
            todos: &'a serde_json::Value,
        }
        self.emit_payload("agent_todo_write", Payload { thread_id, todos })
    }

    fn emit_plan_changed(&self, payload: &PlanChangedPayload) -> Result<(), String> {
        self.emit_payload(PLAN_CHANGED_EVENT, payload)
    }

    async fn spawn_shell_stream(&self, req: ShellStreamRequest) -> Result<SpawnOutcome, String> {
        // A background process streams to the UI, which the model never sees.
        // Mirror it into a file beside the thread so the agent can read what
        // its dev server actually printed — the same shape as spilled tool
        // output, and cleaned up with the thread.
        let log_path = self.resolve_background_log_path(&req.thread_id, &req.process_id);

        // Register synchronously before yielding to the spawned task. This
        // makes an immediate shell_list_processes call see the new process.
        streams::register_command_stream(
            req.request_id.clone(),
            req.process_id.clone(),
            req.name.clone(),
            req.command.clone(),
            req.cwd.clone(),
            log_path.clone(),
        );
        streams::tag_command_stream_thread(&req.request_id, &req.thread_id);
        let events = self.events.clone();
        let process_id = req.process_id.clone();
        let log_for_task = log_path.clone();
        let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
        // Queue the streaming command. The frontend already listens on
        // `shell-stream-{request_id}` so events flow through the existing
        // emit path; the short wait below only confirms startup.
        tokio::spawn(async move {
            let result = streams::execute_command_stream(
                events,
                req.request_id,
                req.command,
                req.cwd,
                req.shell,
                req.timeout_ms,
                log_for_task,
                // A background process gets a stdin Aurora holds open for its
                // whole life. Inheriting a GUI app's dead stdin means instant
                // EOF, and a server that reads stdin and treats EOF as "shut
                // down" then dies seconds after a clean start — silently.
                Some(true),
            )
            .await;
            let _ = completion_tx.send(result);
        });

        // shell_spawn is specifically for long-running work. Give the wrapper
        // a short window to settle before claiming it started; otherwise a port
        // collision such as EADDRINUSE returns a plausible process ID that is
        // already absent from the ledger by the next tool call.
        //
        // Exiting inside that window is reported, not judged: the caller
        // decides, because exit 0 means the command simply finished quickly
        // while a non-zero exit means it never got going.
        match tokio::time::timeout(std::time::Duration::from_millis(1_000), completion_rx).await {
            Err(_) => Ok(SpawnOutcome::Running {
                output_file: log_path,
            }),
            Ok(Ok(Ok(output))) => Ok(SpawnOutcome::Exited(ShellRunOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code,
                success: output.success,
                timed_out: output.timed_out,
                left_running: output.left_running,
                survivors: output.survivors.clone(),
                // A spawn that exited inside its startup window ran to
                // completion; nothing detached it.
                detached: false,
                output_file: log_path.clone(),
            })),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(format!(
                "background process {process_id} stopped before startup could be confirmed"
            )),
        }
    }

    async fn run_shell_stream(&self, req: ShellStreamRequest) -> Result<ShellRunOutput, String> {
        // `execute_command_stream` registers the process itself, emits
        // `shell-stream-{request_id}` chunks as they arrive, and resolves with
        // the complete output. Awaiting it gives the tool one final result
        // while the UI has already been painting the output live.
        //
        // It is spawned rather than awaited inline so the run can OUTLIVE this
        // await. "Run in background" on the card must not stop the loop — the
        // loop is what drains the child's pipes, and a full pipe blocks the
        // child — so the only thing that ends here is the waiting.
        let request_id = req.request_id.clone();
        // A foreground command now mirrors to a log for the same reason a
        // background one does: the moment it is detached, the tool result stops
        // being the record of what it printed. Written for every run, because a
        // file opened at the click would begin after everything already said.
        let log_path = self.resolve_background_log_path(&req.thread_id, &req.process_id);
        let events = self.events.clone();
        let log_for_task = log_path.clone();
        let handle = tokio::spawn(async move {
            streams::execute_command_stream(
                events,
                req.request_id,
                req.command,
                req.cwd,
                req.shell,
                req.timeout_ms,
                log_for_task,
                // Foreground commands read a deterministic, immediately closed
                // stdin — anything that waits on input gets EOF, not a hang.
                Some(false),
            )
            .await
        });

        let output = tokio::select! {
            biased;
            // Checked first: a command that finishes in the same instant the
            // button is pressed has a real result, and reporting "still
            // running" over a process that has already exited would be the
            // `browser_navigate` lie again (lesson.md, 2026-08-21).
            joined = handle => match joined {
                Ok(result) => result?,
                Err(err) => return Err(format!("shell command task failed: {err}")),
            },
            () = streams::detached_mid_run(&request_id) => {
                // The task is deliberately NOT aborted. It keeps streaming into
                // the card's channel, keeps writing the log, keeps its ledger
                // row for the dock and `shell_kill`, and still announces the
                // ending on `shell-process-ended`.
                return Ok(ShellRunOutput {
                    // What it printed before the hand-off. Read back off the
                    // log because the buffers live inside the task that is
                    // still filling them.
                    stdout: streams::read_process_log_tail(log_path.as_deref()),
                    stderr: String::new(),
                    exit_code: None,
                    success: false,
                    timed_out: false,
                    left_running: true,
                    survivors: Vec::new(),
                    detached: true,
                    output_file: log_path,
                });
            }
        };

        Ok(ShellRunOutput {
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: output.exit_code,
            success: output.success,
            timed_out: output.timed_out,
            left_running: output.left_running,
            survivors: output.survivors,
            detached: false,
            output_file: log_path,
        })
    }

    fn emit_file_changed(&self, payload: &FileChangedPayload) -> Result<(), String> {
        // Forward the full payload verbatim. `FileChangedPayload`
        // is `serde(rename_all = "camelCase")` so the frontend reads
        // `kind`, `isDirectory`, `oldPath`, `sourceTool`, `toolCallId`
        // without case juggling.
        self.emit_payload(FILE_CHANGED_EVENT, payload)
    }

    /// Same path `spawn_shell_stream` mirrors output into, recomputed on
    /// demand — that is what lets `shell_read_output` find a log after the
    /// process is gone from the ledger.
    fn background_log_path(&self, thread_id: &str, process_id: &str) -> Option<String> {
        self.resolve_background_log_path(thread_id, process_id)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::agent_runtime::host::startup::ApiAdapters;

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventSink for Recorded {
        fn emit_value(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    fn sink_with_registry() -> (Arc<Recorded>, Arc<AgentRegistry>, HostIdeEventSink) {
        let dir = tempfile::tempdir().unwrap().keep();
        let registry = Arc::new(AgentRegistry::new(Arc::new(ApiAdapters), dir));
        let recorded = Arc::new(Recorded::default());
        let sink = HostIdeEventSink::new(recorded.clone(), &registry);
        (recorded, registry, sink)
    }

    #[test]
    fn editor_and_checklist_events_keep_the_window_payloads() {
        let (recorded, _registry, sink) = sink_with_registry();
        sink.emit_editor_open("src/main.rs", Some(4), None).unwrap();
        sink.emit_todo_write("thread-1", &serde_json::json!([{ "id": 1 }]))
            .unwrap();

        let seen = recorded.0.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                (
                    "agent_editor_open".to_string(),
                    serde_json::json!({ "path": "src/main.rs", "line": 4 }),
                ),
                (
                    "agent_todo_write".to_string(),
                    serde_json::json!({ "threadId": "thread-1", "todos": [{ "id": 1 }] }),
                ),
            ]
        );
    }

    #[test]
    fn no_log_path_once_the_registry_is_gone() {
        let (_recorded, registry, sink) = sink_with_registry();
        drop(registry);
        assert_eq!(sink.background_log_path("thread-1", "bg-1"), None);
    }
}
