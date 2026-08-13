//! `report_aurora_issue` — the agent reporting a fault in Aurora itself.
//!
//! ## Why a tool and not a rule
//!
//! This started as a paragraph in the user's global instructions: notice when
//! Aurora misbehaves, remember it, and mention it at the end of the task. That
//! shape cannot work. "The end of the task" is not an event a model can detect —
//! a turn simply stops when tools stop being called — and "remember it" asks the
//! model to hold an observation across up to 25 tool iterations while context
//! compaction is free to summarise it away. The instruction fired almost never,
//! and when it did the report landed as prose in a chat nobody greps.
//!
//! A tool call is an event with a result. It happens at the moment of noticing,
//! it writes to disk immediately, and it comes back with a confirmation the
//! model can see. That is the whole difference.
//!
//! ## Append-only, on purpose
//!
//! One operation: append. There is no read, no edit, no delete, no path
//! argument. A bug log the agent can rewrite is a bug log that can lose the
//! entry that mattered, and a path argument would let reports scatter into
//! whatever repository happened to be open — Aurora's faults do not belong in
//! the user's project, where they get committed by accident.
//!
//! The file lives at `<AuroraIDE root>/reports/aurora-issues.md` and is created
//! on first write. Settings → Diagnostics renders it.
//!
//! Aurora writes the stamp (UTC timestamp + thread id); the model's text is
//! appended verbatim underneath. The model does not reliably know the date, and
//! the thread id is what makes a report reproducible — neither should be its
//! job, and a stamp it could forge is not a record.

use std::io::Write;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

/// Names this bucket registers, in roster order.
pub const TOOL_NAMES: &[&str] = &["report_aurora_issue"];

/// Shortest report worth keeping. Below this it cannot carry what was called,
/// what came back, and what was expected — the three things that make a report
/// actionable rather than a note that something felt wrong.
const MIN_REPORT_LEN: usize = 40;

/// Ceiling on a single entry. A report is a description, not a paste of the
/// whole tool output; past this the file stops being scannable, which is the
/// only thing it is for.
const MAX_REPORT_LEN: usize = 8_000;

/// Absolute path of the issues file: `<root>/reports/aurora-issues.md`.
pub fn issues_path() -> std::path::PathBuf {
    crate::paths::reports_dir().join("aurora-issues.md")
}

/// Stamp an entry and append it to `path`, creating the file if absent.
///
/// Takes the path rather than calling [`issues_path`] so this is testable
/// without writing into the user's real diagnostics file — a unit test that
/// pollutes the surface it is testing is how a fake report ends up being read
/// as a real one.
fn append_entry(path: &std::path::Path, thread_id: &str, report: &str) -> Result<(), ToolError> {
    let stamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%SZ");
    let entry = format!("\n## {stamp} · thread `{thread_id}`\n\n{}\n", report.trim_end());

    // Append-only, created on first write. `append(true)` is the whole
    // concurrency story: two threads reporting at once interleave entries
    // rather than truncating each other, because neither ever seeks.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| {
            ToolError::Execution(format!(
                "could not open the Aurora issues file at {}: {err}",
                path.display()
            ))
        })?;
    file.write_all(entry.as_bytes()).map_err(|err| {
        ToolError::Execution(format!(
            "could not append to the Aurora issues file at {}: {err}",
            path.display()
        ))
    })
}

pub struct ReportAuroraIssueTool;

#[async_trait]
impl ToolExecutor for ReportAuroraIssueTool {
    fn name(&self) -> &str {
        "report_aurora_issue"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "report_aurora_issue".into(),
            description: "Report a fault in Aurora — the IDE you are running inside — so it can be \
fixed. Aurora is under active development by the user; a fault you swallow is one they never learn \
about.

Call this the MOMENT you notice, never at the end of the task. Then carry on and finish the work.

Report when a tool returns a path, file, or symbol that does not exist; when a result contradicts \
what you just read from disk; when a tool reports success but nothing changed; when output arrives \
truncated, malformed, or in the wrong shape; or when something fails with an error that names no \
cause.

Do NOT report your own misuse. Before calling this, re-run the smallest version of the call once. \
If it behaves the second time, it was you — say nothing and carry on. Report the tool, not the \
model: a refusal you disagree with, a task you found hard, and your own wrong argument are not \
Aurora faults.

Write `report` as markdown, in this shape:

    Called: <the exact call, arguments trimmed>
    Aurora returned: <what you actually got>
    Expected: <what was true, and how you know>
    Impact: <what it cost the task, or \"none — worked around\">

Aurora stamps each entry with the time and this conversation's id, so do not write those yourself. \
The user reads these in Settings → Diagnostics.

Mention in your final message, in one line, that you reported it and what it was. If a fault blocks \
the task outright, say so immediately instead of working around it silently."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "report": {
                        "type": "string",
                        "description": "The report itself, as markdown. Called / Aurora returned / \
Expected / Impact — enough for someone who was not here to reproduce it."
                    }
                },
                "required": ["report"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let report = input
            .get("report")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`report` is required: describe what you called, what Aurora returned, what \
you expected, and what it cost."
                        .into(),
                )
            })?;

        // Rejected rather than accepted-and-padded. A two-word report costs the
        // reader more than it gives: they still have to come and ask.
        if report.len() < MIN_REPORT_LEN {
            return Err(ToolError::InvalidInput(format!(
                "`report` is {} characters — too short to act on. State what you called, what \
Aurora returned, what you expected, and the impact.",
                report.len()
            )));
        }
        if report.len() > MAX_REPORT_LEN {
            return Err(ToolError::InvalidInput(format!(
                "`report` is {} characters; keep it under {MAX_REPORT_LEN}. Describe the fault — \
do not paste the whole tool output.",
                report.len()
            )));
        }

        let path = issues_path();
        append_entry(&path, &ctx.thread_id, report)?;

        Ok(json!({
            "success": true,
            "recorded": true,
            "path": path.to_string_lossy(),
            "note": "Recorded. Finish the task, and mention this in one line in your final message."
        })
        .to_string())
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(ReportAuroraIssueTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            thread_id: "thread-abc".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    const REPORT: &str = "Called: file_read on src/main.rs\nAurora returned: file not found\n\
Expected: the file exists, workspace_tree listed it\nImpact: had to glob for it";

    fn valid_report() -> Value {
        json!({ "report": REPORT })
    }

    /// A scratch path under the OS temp dir — never the user's real file.
    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aurora-issues-test-{name}.md"))
    }

    #[test]
    fn creates_the_file_on_first_report_and_keeps_the_text_verbatim() {
        let path = scratch("create");
        let _ = std::fs::remove_file(&path);

        append_entry(&path, "thread-abc", REPORT).expect("first append creates the file");

        let text = std::fs::read_to_string(&path).expect("file exists after the call");
        assert!(text.contains("thread-abc"), "stamped with the thread id");
        assert!(
            text.contains("Called: file_read on src/main.rs"),
            "the model's text is kept verbatim"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Append-only: a second report must not overwrite the first.
    #[test]
    fn a_second_report_is_added_not_replaced() {
        let path = scratch("append");
        let _ = std::fs::remove_file(&path);

        append_entry(&path, "thread-1", REPORT).expect("first");
        append_entry(&path, "thread-2", REPORT).expect("second");

        let text = std::fs::read_to_string(&path).expect("file exists");
        assert!(text.contains("thread-1") && text.contains("thread-2"), "both kept");
        assert_eq!(text.matches("## ").count(), 2, "two stamped entries");
        let _ = std::fs::remove_file(&path);
    }

    /// The stamp is Aurora's, not the model's — a report it could backdate is
    /// not a record.
    #[test]
    fn stamps_every_entry_itself() {
        let path = scratch("stamp");
        let _ = std::fs::remove_file(&path);

        append_entry(&path, "thread-abc", REPORT).expect("append");

        let text = std::fs::read_to_string(&path).expect("file exists");
        let today = chrono::Utc::now().format("## %Y-%m-%d").to_string();
        assert!(text.contains(&today), "entry heading carries today's date");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn rejects_a_report_too_short_to_act_on() {
        let err = ReportAuroraIssueTool
            .execute(json!({ "report": "grep is broken" }), &ctx())
            .await
            .expect_err("too short");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_a_missing_report() {
        let err = ReportAuroraIssueTool
            .execute(json!({}), &ctx())
            .await
            .expect_err("no report");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_a_pasted_wall_of_output() {
        let err = ReportAuroraIssueTool
            .execute(json!({ "report": "x".repeat(MAX_REPORT_LEN + 1) }), &ctx())
            .await
            .expect_err("too long");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
