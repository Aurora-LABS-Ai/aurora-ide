//! IDE event sink — production wiring lives in `lib.rs::setup`.
//!
//! Splits the Tauri `AppHandle` dependency away from
//! [`crate::agent_runtime::tool_executor::ToolContext`] so the bucket
//! can run inside the standalone verify crate (no Tauri).
//!
//! Sink shape on purpose:
//!
//! - **Editor / todo tools** call non-async methods because they're
//!   fire-and-forget — the frontend updates from the event itself,
//!   not from the tool result. A failed emit is still surfaced as
//!   `Err` so the executor can convert to `ToolError::Execution` if
//!   it really cares; in practice the production sink (Tauri) never
//!   fails to emit.
//! - **`spawn_shell_stream`** is async because the production impl
//!   hands the work off to a `tokio::spawn` that re-enters
//!   `crate::commands::execute_command_stream` (which itself
//!   awaits). The tool returns the request_id immediately, like the
//!   TS executor does.
//!
//! The verify crate uses [`RecordingIdeEventSink`] and asserts on
//! `events()` to verify each tool emits the right event channel + payload.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;

/// Tauri event channel emitted by [`crate::tools::shell_editor_todo::editor_open_file`].
pub const EDITOR_OPEN_EVENT: &str = "agent_editor_open";

/// Tauri event channel emitted by [`crate::tools::shell_editor_todo::read_lints`].
pub const READ_LINTS_EVENT: &str = "agent_read_lints";

/// Tauri event channel emitted by [`crate::tools::shell_editor_todo::todo_write`].
pub const TODO_WRITE_EVENT: &str = "agent_todo_write";

/// One in-flight shell stream request handed to [`IdeEventSink::spawn_shell_stream`].
///
/// The production sink uses these to call
/// [`crate::commands::execute_command_stream`]; the verify mock just
/// records them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellStreamRequest {
    pub request_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// Recorded emission for the verify crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordedEvent {
    EditorOpen { path: String, line: Option<u64>, column: Option<u64> },
    ReadLints { paths: Vec<String> },
    TodoWrite { todos: Value },
    ShellStream(ShellStreamRequest),
}

#[async_trait]
pub trait IdeEventSink: Send + Sync + 'static {
    /// Emit the `"agent_editor_open"` Tauri event with the path the
    /// agent wants Monaco to focus.
    fn emit_editor_open(
        &self,
        path: &str,
        line: Option<u64>,
        column: Option<u64>,
    ) -> Result<(), String>;

    /// Emit the `"agent_read_lints"` Tauri event with the paths to
    /// re-lint.
    fn emit_read_lints(&self, paths: &[String]) -> Result<(), String>;

    /// Emit the `"agent_todo_write"` Tauri event with the new task list.
    fn emit_todo_write(&self, todos: &Value) -> Result<(), String>;

    /// Spawn a streamed shell command in the background and return.
    ///
    /// Production impls hand off to a `tokio::spawn` running
    /// [`crate::commands::execute_command_stream`]; the request_id
    /// becomes the channel suffix the frontend already listens on
    /// (`shell-stream-{request_id}`). Tests just record the request.
    async fn spawn_shell_stream(&self, req: ShellStreamRequest) -> Result<(), String>;
}

/// No-op sink for unit tests that don't care about emissions.
///
/// All methods return `Ok(())`. Use [`RecordingIdeEventSink`] when the
/// test needs to assert what was emitted.
pub struct NoopIdeEventSink;

#[async_trait]
impl IdeEventSink for NoopIdeEventSink {
    fn emit_editor_open(
        &self,
        _path: &str,
        _line: Option<u64>,
        _column: Option<u64>,
    ) -> Result<(), String> {
        Ok(())
    }

    fn emit_read_lints(&self, _paths: &[String]) -> Result<(), String> {
        Ok(())
    }

    fn emit_todo_write(&self, _todos: &Value) -> Result<(), String> {
        Ok(())
    }

    async fn spawn_shell_stream(&self, _req: ShellStreamRequest) -> Result<(), String> {
        Ok(())
    }
}

/// Recording sink the verify crate uses to assert per-tool behaviour.
///
/// `events()` returns a snapshot of every recorded emission in
/// arrival order.
#[derive(Default)]
pub struct RecordingIdeEventSink {
    events: Mutex<Vec<RecordedEvent>>,
    fail_next: Mutex<Option<String>>,
}

impl RecordingIdeEventSink {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Snapshot the recorded emissions.
    pub fn events(&self) -> Vec<RecordedEvent> {
        self.events.lock().clone()
    }

    pub fn event_count(&self) -> usize {
        self.events.lock().len()
    }

    /// Make the next `emit_*` / `spawn_shell_stream` return
    /// `Err(message)`. Used to test that the executors propagate the
    /// emit error as `ToolError::Execution`.
    pub fn fail_next(&self, message: impl Into<String>) {
        *self.fail_next.lock() = Some(message.into());
    }

    fn take_failure(&self) -> Option<String> {
        self.fail_next.lock().take()
    }

    fn record(&self, evt: RecordedEvent) -> Result<(), String> {
        if let Some(err) = self.take_failure() {
            return Err(err);
        }
        self.events.lock().push(evt);
        Ok(())
    }
}

#[async_trait]
impl IdeEventSink for RecordingIdeEventSink {
    fn emit_editor_open(
        &self,
        path: &str,
        line: Option<u64>,
        column: Option<u64>,
    ) -> Result<(), String> {
        self.record(RecordedEvent::EditorOpen {
            path: path.to_string(),
            line,
            column,
        })
    }

    fn emit_read_lints(&self, paths: &[String]) -> Result<(), String> {
        self.record(RecordedEvent::ReadLints {
            paths: paths.to_vec(),
        })
    }

    fn emit_todo_write(&self, todos: &Value) -> Result<(), String> {
        self.record(RecordedEvent::TodoWrite { todos: todos.clone() })
    }

    async fn spawn_shell_stream(&self, req: ShellStreamRequest) -> Result<(), String> {
        self.record(RecordedEvent::ShellStream(req))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_sink_is_silent() {
        let sink = NoopIdeEventSink;
        assert!(sink.emit_editor_open("p", None, None).is_ok());
        assert!(sink.emit_read_lints(&[]).is_ok());
        assert!(sink.emit_todo_write(&serde_json::json!([])).is_ok());
    }

    #[test]
    fn recording_sink_captures_in_order() {
        let sink = RecordingIdeEventSink::new();
        sink.emit_editor_open("foo.rs", Some(10), Some(2)).unwrap();
        sink.emit_read_lints(&vec!["a.rs".into(), "b.rs".into()]).unwrap();
        sink.emit_todo_write(&serde_json::json!([{"content":"hi","activeForm":"saying hi","status":"pending"}])).unwrap();

        let events = sink.events();
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[0], RecordedEvent::EditorOpen { path, line, column } if path == "foo.rs" && line == &Some(10) && column == &Some(2)));
        assert!(matches!(&events[1], RecordedEvent::ReadLints { paths } if paths == &vec!["a.rs".to_string(), "b.rs".to_string()]));
        assert!(matches!(&events[2], RecordedEvent::TodoWrite { .. }));
    }

    #[tokio::test]
    async fn recording_sink_fail_next_short_circuits_one_call() {
        let sink = RecordingIdeEventSink::new();
        sink.fail_next("boom");
        let err = sink.emit_editor_open("a", None, None).expect_err("must fail");
        assert_eq!(err, "boom");
        // Subsequent call succeeds
        sink.emit_editor_open("b", None, None).expect("ok");
        assert_eq!(sink.event_count(), 1);

        sink.fail_next("shell err");
        let err = sink
            .spawn_shell_stream(ShellStreamRequest {
                request_id: "r1".into(),
                command: "ls".into(),
                cwd: None,
                shell: None,
                timeout_ms: None,
            })
            .await
            .expect_err("must fail");
        assert_eq!(err, "shell err");
    }
}
