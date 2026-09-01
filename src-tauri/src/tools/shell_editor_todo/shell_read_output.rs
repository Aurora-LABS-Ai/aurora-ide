//! `shell_read_output` — read a background process's output by line, and
//! optionally wait for more.
//!
//! ## Why this exists
//!
//! `shell_spawn` mirrors a process's output into a log file and
//! `shell_list_processes` told the agent to "read that file with file_read".
//! Following that advice literally is how a 60-second probe cost fifteen tool
//! calls: the agent re-read the log with an incrementing `start_line` and no way
//! to tell "nothing new yet" from "the run is over", so its only move was to
//! poll again and hope.
//!
//! This tool turns that loop into one call. It reads from `start_line` like
//! `file_read` does, but it also knows two things `file_read` cannot:
//!
//! 1. **Whether the run ended**, from the `[aurora]` footer line — so the agent
//!    stops polling a process that is already gone.
//! 2. **How to wait.** With `wait_ms` it blocks until new output appears rather
//!    than returning empty, which is the difference between "poll and hope" and
//!    "wait and react".
//!
//! ## Line contract
//!
//! Same shape as `file_read`'s: `start_line` is 1-indexed and inclusive, the
//! result is exactly what was asked for up to `max_lines`, and
//! `nextStartLine` is where the following call should resume. Every payload
//! carries the exact-read marker so neither the spill layer nor the per-tool
//! truncation re-bounds output this tool already bounded honestly.
//!
//! `requires_permission()` is **false** — reading a log Aurora itself wrote
//! mutates nothing.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;

/// Lines returned when the caller does not say.
const DEFAULT_MAX_LINES: usize = 200;
/// Ceiling on `max_lines`. Above this the model should be reading in chunks.
const MAX_MAX_LINES: usize = 2_000;
/// Byte ceiling, independent of the line count — one 5 MB minified line must
/// not blow up the turn just because it counts as a single line.
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
/// Longest a single call will wait for new output.
const MAX_WAIT_MS: u64 = 120_000;
/// How often the wait loop re-checks the log.
const POLL_INTERVAL_MS: u64 = 250;

pub struct ShellReadOutputTool {
    sink: Arc<dyn IdeEventSink>,
}

impl ShellReadOutputTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for ShellReadOutputTool {
    fn name(&self) -> &str {
        "shell_read_output"
    }

    /// Reads a file Aurora writes; starts, stops, and changes nothing.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_read_output".into(),
            description: "Read what a background process started by shell_spawn has printed, and \
                          optionally wait for more.\n\n\
                          Prefer this over reading the process's log with file_read: it tells you \
                          whether the run is still going, and with `wait_ms` it blocks until new \
                          output arrives instead of returning empty and making you poll again.\n\n\
                          To follow a process: call with `start_line: 1`, then pass the returned \
                          `nextStartLine` as `start_line` on each later call, with `wait_ms` set to \
                          how long you are willing to wait. When `running` is false the run has \
                          ended and `ending` says how — stop polling."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "processId": {
                        "type": "string",
                        "description": "The process ID returned by shell_spawn (also listed by shell_list_processes)."
                    },
                    "start_line": {
                        "type": "number",
                        "description": "First line to return, 1-indexed and inclusive. Defaults to 1. Pass the previous call's `nextStartLine` to read only what is new."
                    },
                    "max_lines": {
                        "type": "number",
                        "description": "Most lines to return. Defaults to 200, maximum 2000."
                    },
                    "wait_ms": {
                        "type": "number",
                        "description": "Wait up to this many milliseconds for new output before returning. Defaults to 0 (return immediately). Maximum 120000. Returns as soon as any new line appears or the run ends, so a generous value costs nothing when output is flowing."
                    }
                },
                "required": ["processId"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let process_id = input
            .get("processId")
            .or_else(|| input.get("process_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput("`processId` must be a non-empty string".into())
            })?
            .to_string();

        let start_line = usize::try_from(
            input
                .get("start_line")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1),
        )
        .unwrap_or(usize::MAX);

        let max_lines = usize::try_from(
            input
                .get("max_lines")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_MAX_LINES as u64),
        )
        .unwrap_or(DEFAULT_MAX_LINES)
        .clamp(1, MAX_MAX_LINES);

        let wait_ms = input
            .get("wait_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(MAX_WAIT_MS);

        let Some(log_path) = self.sink.background_log_path(&ctx.thread_id, &process_id) else {
            return Ok(json!({
                "success": false,
                "processId": process_id,
                "message": "This conversation has no background-process log directory, so there is \
                            nothing to read. Start the process with shell_spawn first.",
            })
            .to_string());
        };

        let tracked = process_is_tracked(&process_id);
        let started = std::time::Instant::now();

        // First look, then wait only if there is genuinely nothing new AND the
        // run has not already ended. A finished run never produces more output,
        // so waiting on one would burn the whole `wait_ms` for nothing.
        let mut snapshot = read_log(&log_path);
        if wait_ms > 0 {
            let deadline = std::time::Duration::from_millis(wait_ms);
            let tick = std::time::Duration::from_millis(POLL_INTERVAL_MS);
            while snapshot.total_lines < start_line && !snapshot.ended {
                if started.elapsed() >= deadline {
                    break;
                }
                let remaining = deadline - started.elapsed();
                tokio::select! {
                    biased;
                    () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
                    () = tokio::time::sleep(tick.min(remaining)) => {}
                }
                snapshot = read_log(&log_path);
            }
        }

        let waited_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let window = slice_lines(&snapshot.lines, start_line, max_lines);
        let running = !snapshot.ended && tracked;

        let message = build_message(&snapshot, &window, start_line, running, tracked, wait_ms);

        Ok(json!({
            "success": true,
            // Bounded by max_lines and MAX_OUTPUT_BYTES above, so the spill
            // layer and per-tool truncation must not bound it a second time —
            // that double-bounding is what turned exact reads into head+tail
            // previews of a range the model explicitly asked for.
            "exactRead": true,
            "processId": process_id,
            "outputFile": log_path,
            "startLine": start_line,
            "endLine": window.end_line,
            "totalLines": snapshot.total_lines,
            "nextStartLine": window.next_start_line,
            "running": running,
            "ending": snapshot.ending,
            "waitedMs": waited_ms,
            "cappedAtMaxLines": window.capped_lines,
            "cappedAtByteLimit": window.capped_bytes,
            "output": window.output,
            "message": message,
        })
        .to_string())
    }
}

/// What the log said at one moment.
struct LogSnapshot {
    lines: Vec<String>,
    total_lines: usize,
    /// True once Aurora has written the closing `[aurora]` line.
    ended: bool,
    /// That closing line verbatim, so the agent learns *how* the run ended
    /// (exit code, timeout, stopped by the user, killed by `shell_kill`).
    ending: Option<String>,
}

fn read_log(path: &str) -> LogSnapshot {
    // Lossy rather than strict: a read can land between the decoder's flushes,
    // and losing a replacement character is better than reporting an unreadable
    // log for a process that is printing fine.
    let text = std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();

    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let ending = lines
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .filter(|line| line.starts_with(crate::commands::PROCESS_LOG_FOOTER_PREFIX))
        .cloned();

    LogSnapshot {
        total_lines: lines.len(),
        ended: ending.is_some(),
        ending,
        lines,
    }
}

/// The slice actually returned, plus where to resume.
struct Window {
    output: String,
    /// Last line included, or `start_line - 1` when nothing was.
    end_line: usize,
    next_start_line: usize,
    capped_lines: bool,
    capped_bytes: bool,
}

/// Exactly the requested range, bounded by `max_lines` and [`MAX_OUTPUT_BYTES`].
///
/// `next_start_line` always names the first line NOT returned, so chaining calls
/// can never skip or repeat a line — including when a byte cap cut the window
/// short of `max_lines`.
fn slice_lines(lines: &[String], start_line: usize, max_lines: usize) -> Window {
    let total = lines.len();
    if start_line > total {
        return Window {
            output: String::new(),
            end_line: start_line.saturating_sub(1),
            next_start_line: start_line,
            capped_lines: false,
            capped_bytes: false,
        };
    }

    let mut output = String::new();
    let mut taken = 0usize;
    let mut capped_bytes = false;

    for line in &lines[start_line - 1..] {
        if taken >= max_lines {
            break;
        }
        let separator = usize::from(!output.is_empty());
        if output.len() + separator + line.len() > MAX_OUTPUT_BYTES {
            if taken == 0 {
                // A single line wider than the whole budget. Returning nothing
                // would leave the caller stuck re-requesting a line it can
                // never receive, so hand back a prefix and count it as taken.
                let room = MAX_OUTPUT_BYTES.saturating_sub(1);
                let mut prefix = String::new();
                for ch in line.chars() {
                    if prefix.len() + ch.len_utf8() > room {
                        break;
                    }
                    prefix.push(ch);
                }
                output.push_str(&prefix);
                taken = 1;
            }
            capped_bytes = true;
            break;
        }
        if separator == 1 {
            output.push('\n');
        }
        output.push_str(line);
        taken += 1;
    }

    let capped_lines = taken == max_lines && start_line - 1 + taken < total;

    Window {
        output,
        end_line: start_line + taken - 1,
        next_start_line: start_line + taken,
        capped_lines,
        capped_bytes,
    }
}

fn build_message(
    snapshot: &LogSnapshot,
    window: &Window,
    start_line: usize,
    running: bool,
    tracked: bool,
    wait_ms: u64,
) -> String {
    if window.output.is_empty() {
        if let Some(ending) = &snapshot.ending {
            return format!(
                "The run has ended and there is no output after line {start}. {ending}",
                start = start_line.saturating_sub(1)
            );
        }
        if !tracked {
            return "No output, and no process with this ID is running in this conversation. \
                    Check the ID with shell_list_processes — a process that already finished may \
                    have been cleaned up."
                .to_string();
        }
        return if wait_ms > 0 {
            format!(
                "Still running, and it printed nothing new within {wait_ms}ms. Call again with the \
                 same start_line to keep waiting."
            )
        } else {
            "Still running, and it has printed nothing new. Call again with wait_ms set to wait for \
             output instead of polling."
                .to_string()
        };
    }

    let mut message = format!(
        "Lines {start}-{end} of {total}.",
        start = start_line,
        end = window.end_line,
        total = snapshot.total_lines
    );

    if window.capped_bytes {
        message.push_str(" Stopped early at the output size limit.");
    } else if window.capped_lines {
        message.push_str(" Capped at max_lines.");
    }

    if running {
        message.push_str(&format!(
            " Still running — continue from start_line: {}.",
            window.next_start_line
        ));
    } else if let Some(ending) = &snapshot.ending {
        message.push_str(&format!(" The run has ended: {ending}"));
    } else if !tracked {
        message.push_str(
            " This process is no longer tracked and its log has no closing line, so it ended \
             without Aurora recording how.",
        );
    }

    message
}

#[cfg(not(feature = "verify_only"))]
fn process_is_tracked(process_id: &str) -> bool {
    crate::commands::list_command_streams()
        .iter()
        .any(|stream| stream.process_id == process_id)
}

#[cfg(feature = "verify_only")]
fn process_is_tracked(_process_id: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;

    /// Sink that points every lookup at one real file on disk.
    struct FileSink(Option<String>);

    #[async_trait]
    impl IdeEventSink for FileSink {
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
        fn emit_todo_write(&self, _thread_id: &str, _todos: &Value) -> Result<(), String> {
            Ok(())
        }
        fn emit_plan_changed(
            &self,
            _payload: &super::super::ide_event_sink::PlanChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
        async fn spawn_shell_stream(
            &self,
            _req: super::super::ide_event_sink::ShellStreamRequest,
        ) -> Result<super::super::ide_event_sink::SpawnOutcome, String> {
            Err("not used".into())
        }
        async fn run_shell_stream(
            &self,
            _req: super::super::ide_event_sink::ShellStreamRequest,
        ) -> Result<super::super::ide_event_sink::ShellRunOutput, String> {
            Err("not used".into())
        }
        fn emit_file_changed(
            &self,
            _payload: &super::super::ide_event_sink::FileChangedPayload,
        ) -> Result<(), String> {
            Ok(())
        }
        fn background_log_path(&self, _session: &str, _process: &str) -> Option<String> {
            self.0.clone()
        }
    }

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

    fn temp_log(contents: &str) -> (PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bg-test.log");
        std::fs::write(&path, contents).expect("write log");
        (path, dir)
    }

    fn tool(path: Option<&PathBuf>) -> ShellReadOutputTool {
        ShellReadOutputTool::new(Arc::new(FileSink(
            path.map(|p| p.to_string_lossy().to_string()),
        )))
    }

    async fn run(tool: &ShellReadOutputTool, input: Value) -> Value {
        let out = tool.execute(input, &ctx()).await.expect("ok");
        serde_json::from_str(&out).expect("json")
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        assert!(!tool(None).requires_permission());
    }

    #[tokio::test]
    async fn rejects_a_missing_process_id() {
        let err = tool(None)
            .execute(json!({}), &ctx())
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn returns_the_exact_requested_range() {
        let body = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (path, _dir) = temp_log(&body);
        let parsed = run(
            &tool(Some(&path)),
            json!({"processId": "bg-test", "start_line": 3, "max_lines": 4}),
        )
        .await;

        assert_eq!(parsed["output"], json!("line 3\nline 4\nline 5\nline 6"));
        assert_eq!(parsed["startLine"], json!(3));
        assert_eq!(parsed["endLine"], json!(6));
        assert_eq!(parsed["nextStartLine"], json!(7));
        assert_eq!(parsed["totalLines"], json!(10));
        assert_eq!(parsed["cappedAtMaxLines"], json!(true));
    }

    /// The whole point of the tool: chaining `nextStartLine` must not skip or
    /// repeat a single line.
    #[tokio::test]
    async fn chained_reads_cover_the_log_exactly_once() {
        let body = (1..=25)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (path, _dir) = temp_log(&body);
        let tool = tool(Some(&path));

        let mut seen: Vec<String> = Vec::new();
        let mut start = 1u64;
        for _ in 0..10 {
            let parsed = run(
                &tool,
                json!({"processId": "bg-test", "start_line": start, "max_lines": 7}),
            )
            .await;
            let chunk = parsed["output"].as_str().unwrap_or_default();
            if !chunk.is_empty() {
                seen.extend(chunk.split('\n').map(str::to_string));
            }
            let next = parsed["nextStartLine"].as_u64().expect("next");
            if next == start {
                break;
            }
            start = next;
        }

        assert_eq!(seen.len(), 25, "every line exactly once: {seen:?}");
        assert_eq!(seen[0], "line 1");
        assert_eq!(seen[24], "line 25");
    }

    #[tokio::test]
    async fn reports_the_run_as_ended_and_quotes_how() {
        let (path, _dir) = temp_log(
            "building\ndone\n[aurora] Exited normally (code 0) — 2026-07-30 10:00:00, ran 1.2s. No further output.\n",
        );
        let parsed = run(&tool(Some(&path)), json!({"processId": "bg-test"})).await;

        assert_eq!(parsed["running"], json!(false));
        assert!(parsed["ending"]
            .as_str()
            .unwrap_or_default()
            .contains("Exited normally"));
        assert!(parsed["message"]
            .as_str()
            .unwrap_or_default()
            .contains("has ended"));
    }

    /// A finished run can never print more, so `wait_ms` must return at once
    /// rather than sleeping out the full budget.
    #[tokio::test]
    async fn does_not_wait_on_a_run_that_already_ended() {
        let (path, _dir) = temp_log("[aurora] Exited with code 1 — ran 2s. No further output.\n");
        let started = std::time::Instant::now();
        let parsed = run(
            &tool(Some(&path)),
            json!({"processId": "bg-test", "start_line": 99, "wait_ms": 5000}),
        )
        .await;

        assert!(
            started.elapsed() < std::time::Duration::from_millis(2_000),
            "returned in {:?}, should not have waited",
            started.elapsed()
        );
        assert_eq!(parsed["running"], json!(false));
    }

    #[tokio::test]
    async fn waiting_stops_at_the_deadline_when_nothing_arrives() {
        let (path, _dir) = temp_log("only line\n");
        let started = std::time::Instant::now();
        let parsed = run(
            &tool(Some(&path)),
            json!({"processId": "bg-test", "start_line": 2, "wait_ms": 600}),
        )
        .await;

        assert!(started.elapsed() >= std::time::Duration::from_millis(500));
        assert_eq!(parsed["output"], json!(""));
        assert_eq!(parsed["nextStartLine"], json!(2), "resume point must hold");
    }

    #[tokio::test]
    async fn returns_as_soon_as_a_new_line_appears() {
        let (path, dir) = temp_log("first\n");
        let writer = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&writer)
                .expect("append");
            let _ = file.write_all(b"second\n");
        });

        let started = std::time::Instant::now();
        let parsed = run(
            &tool(Some(&path)),
            json!({"processId": "bg-test", "start_line": 2, "wait_ms": 10_000}),
        )
        .await;

        assert_eq!(parsed["output"], json!("second"));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "should return on first new line, took {:?}",
            started.elapsed()
        );
        drop(dir);
    }

    #[tokio::test]
    async fn cancel_during_a_wait_short_circuits() {
        let (path, _dir) = temp_log("only line\n");
        let context = ctx();
        let token = context.cancel_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            token.cancel();
        });

        let err = tool(Some(&path))
            .execute(
                json!({"processId": "bg-test", "start_line": 5, "wait_ms": 30_000}),
                &context,
            )
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
    }

    #[tokio::test]
    async fn a_start_line_past_the_end_is_empty_not_an_error() {
        let (path, _dir) = temp_log("a\nb\n");
        let parsed = run(
            &tool(Some(&path)),
            json!({"processId": "bg-test", "start_line": 50}),
        )
        .await;

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["output"], json!(""));
        assert_eq!(parsed["nextStartLine"], json!(50));
    }

    #[tokio::test]
    async fn a_missing_log_reads_as_no_output_yet() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("never-written.log");
        let parsed = run(&tool(Some(&path)), json!({"processId": "bg-test"})).await;

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["totalLines"], json!(0));
        assert_eq!(parsed["output"], json!(""));
    }

    #[tokio::test]
    async fn says_so_when_the_thread_has_no_log_directory() {
        let parsed = run(&tool(None), json!({"processId": "bg-test"})).await;
        assert_eq!(parsed["success"], json!(false));
        assert!(parsed["message"]
            .as_str()
            .unwrap_or_default()
            .contains("shell_spawn"));
    }

    #[tokio::test]
    async fn payload_carries_the_exact_read_marker() {
        let (path, _dir) = temp_log("a\n");
        let out = tool(Some(&path))
            .execute(json!({"processId": "bg-test"}), &ctx())
            .await
            .expect("ok");
        assert!(
            out.contains(crate::tools::file_workspace_search::EXACT_READ_MARKER),
            "spill and truncation must skip this payload: {out}"
        );
    }

    #[test]
    fn max_lines_is_clamped_to_the_ceiling() {
        // Guards the clamp directly: a model asking for 10_000 lines gets 2_000,
        // not a 10_000-line payload the pipeline then mangles.
        let lines: Vec<String> = (1..=3_000).map(|i| format!("line {i}")).collect();
        let window = slice_lines(&lines, 1, MAX_MAX_LINES);
        assert_eq!(window.end_line, MAX_MAX_LINES);
        assert_eq!(window.next_start_line, MAX_MAX_LINES + 1);
        assert!(window.capped_lines);
    }

    #[test]
    fn one_oversized_line_still_makes_progress() {
        let lines = vec!["x".repeat(MAX_OUTPUT_BYTES * 2), "next".to_string()];
        let window = slice_lines(&lines, 1, 10);
        assert!(!window.output.is_empty(), "must return something");
        assert!(window.output.len() <= MAX_OUTPUT_BYTES);
        assert!(window.capped_bytes);
        // Progress: the next call starts after the giant line, so a chained
        // reader can never wedge on it.
        assert_eq!(window.next_start_line, 2);
    }

    #[test]
    fn the_byte_cap_keeps_the_resume_point_exact() {
        let line = "y".repeat(1_000);
        let lines: Vec<String> = (0..500).map(|_| line.clone()).collect();
        let window = slice_lines(&lines, 1, MAX_MAX_LINES);
        assert!(window.capped_bytes);
        // Whatever fit, nextStartLine names the first line NOT returned.
        let returned = window.output.split('\n').count();
        assert_eq!(window.next_start_line, returned + 1);
    }
}
