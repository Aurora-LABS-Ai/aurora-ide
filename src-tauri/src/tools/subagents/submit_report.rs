//! `submit_report` — how a CHILD ends: it hands its report in.
//!
//! Before this tool the report was whatever the child said last. A model that
//! closed with "Done." or ended on a tool call left its parent a report of
//! one word, or of nothing. Now the report is something the child chooses to
//! submit, with an outcome, a summary and the full text kept apart, so the
//! parent can act on the outcome without reading every line. Claude Code
//! does the same for agents that must return a result (`StructuredOutput`,
//! enforced by a stop hook); `ChildRun` is the enforcement here: a run that
//! ends without submitting is asked once, then falls back to its last message,
//! flagged as such.
//!
//! The report is held, not sent: the child may still be working, a second
//! call replaces the first, and delivery happens once, when the run ends.
//!
//! Installed for child turns only (`ToolScope::Child`), whatever the
//! definition's allow-list says.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{
    ParentMessenger, ReportOutcome, SubagentError, SubmittedReport,
};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::required_str;

pub const SUBMIT_REPORT_TOOL: &str = "submit_report";

/// Longest summary kept. The summary is what the parent reads first and what
/// the window shows on the report card; the detail belongs in `report`.
const MAX_SUMMARY_CHARS: usize = 1_200;

/// Most changed files listed. A run that touched more says so in `report`.
const MAX_CHANGED_FILES: usize = 200;

pub struct SubmitReportTool {
    messenger: Arc<dyn ParentMessenger>,
}

impl SubmitReportTool {
    #[must_use]
    pub fn new(messenger: Arc<dyn ParentMessenger>) -> Self {
        Self { messenger }
    }
}

fn outcome(input: &Value) -> Result<ReportOutcome, ToolError> {
    match input.get("outcome").and_then(Value::as_str).map(str::trim) {
        Some("done") => Ok(ReportOutcome::Done),
        Some("partial") => Ok(ReportOutcome::Partial),
        Some("blocked") => Ok(ReportOutcome::Blocked),
        Some(other) => Err(ToolError::InvalidInput(format!(
            "`outcome` {other:?} must be one of \"done\", \"partial\", \"blocked\""
        ))),
        None => Err(ToolError::InvalidInput(
            "`outcome` is required: \"done\", \"partial\" or \"blocked\"".into(),
        )),
    }
}

fn changed_files(input: &Value) -> Result<Vec<String>, ToolError> {
    let Some(value) = input.get("changedFiles") else {
        return Ok(Vec::new());
    };
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        // One path where a list was asked for: take it rather than fail the
        // one call that ends the run.
        Value::String(one) => {
            let one = one.trim();
            return Ok(if one.is_empty() {
                Vec::new()
            } else {
                vec![one.to_string()]
            });
        }
        _ => {
            return Err(ToolError::InvalidInput(
                "`changedFiles` must be an array of paths".into(),
            ))
        }
    };
    let mut out: Vec<String> = Vec::new();
    for item in items.iter().take(MAX_CHANGED_FILES) {
        let Some(path) = item.as_str().map(str::trim).filter(|p| !p.is_empty()) else {
            return Err(ToolError::InvalidInput(
                "`changedFiles` must be an array of paths".into(),
            ));
        };
        if !out.iter().any(|p| p == path) {
            out.push(path.to_string());
        }
    }
    Ok(out)
}

#[async_trait]
impl ToolExecutor for SubmitReportTool {
    fn name(&self) -> &str {
        SUBMIT_REPORT_TOOL
    }

    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: SUBMIT_REPORT_TOOL.into(),
            description: "Hand your report to the parent agent. This is how you finish: call it \
                          once, when the work is done or cannot go further, then end your turn \
                          with one short line and no more tool calls. The parent reads this \
                          report and nothing else of what you did, so it must stand on its own. \
                          Call it again only to correct it; the last call replaces the earlier \
                          one."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "outcome": {
                        "type": "string",
                        "enum": ["done", "partial", "blocked"],
                        "description": "done: the task is complete as asked. partial: some of it is done and the report says what is left. blocked: it could not be done and the report says why."
                    },
                    "summary": {
                        "type": "string",
                        "description": "One to three sentences the parent can act on: the answer, or what happened. No preamble."
                    },
                    "report": {
                        "type": "string",
                        "description": "The full report: what you did, what you found with exact file paths and line numbers, what you verified and how, and anything left undone or uncertain. Markdown."
                    },
                    "changedFiles": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Workspace-relative paths you created, changed, moved or deleted. Omit when you changed nothing."
                    }
                },
                "required": ["outcome", "summary", "report"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let outcome = outcome(&input)?;
        let mut summary = required_str(&input, "summary")?;
        if summary.chars().count() > MAX_SUMMARY_CHARS {
            summary = summary.chars().take(MAX_SUMMARY_CHARS).collect::<String>();
            summary.push('…');
        }
        let report = required_str(&input, "report")?;
        let changed_files = changed_files(&input)?;
        let replaced = self
            .messenger
            .submit_report(SubmittedReport {
                outcome,
                summary,
                report,
                changed_files,
            })
            .map_err(|e| match e {
                SubagentError::Invalid(msg) => ToolError::InvalidInput(msg),
                other => ToolError::Execution(other.to_string()),
            })?;
        Ok(serde_json::to_string_pretty(&json!({
            "submitted": true,
            "replacedEarlier": replaced,
            "hint": "Report submitted. It goes to the parent when you end your turn. End it now \
                     with one short line and no more tool calls. If the parent sends you more \
                     work later, you will submit a new report for it.",
        }))
        .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::test_support::{context, parent_turn};
    use super::*;
    use crate::agent_runtime::subagents::host::MessageDelivery;

    #[derive(Default)]
    struct Holder {
        held: Mutex<Vec<SubmittedReport>>,
    }

    impl ParentMessenger for Holder {
        fn message_parent(&self, _text: &str, _waiting: bool) -> Result<MessageDelivery, SubagentError> {
            Ok(MessageDelivery::QueuedIntoTurn)
        }

        fn submit_report(&self, report: SubmittedReport) -> Result<bool, SubagentError> {
            let mut held = self.held.lock().unwrap();
            let replaced = !held.is_empty();
            held.push(report);
            Ok(replaced)
        }
    }

    #[tokio::test]
    async fn a_report_is_held_with_its_outcome_summary_and_files() {
        let holder = Arc::new(Holder::default());
        let tool = SubmitReportTool::new(holder.clone());
        let parent = parent_turn();
        let out = tool
            .execute(
                json!({
                    "outcome": "partial",
                    "summary": "Login is in src/auth.ts:42; logout is not wired.",
                    "report": "## Found\n- src/auth.ts:42",
                    "changedFiles": ["src/auth.ts", "src/auth.ts", "  "]
                }),
                &context(&parent),
            )
            .await
            .unwrap_err();
        // A blank path is not a path.
        assert!(matches!(out, ToolError::InvalidInput(_)));

        let out = tool
            .execute(
                json!({
                    "outcome": "partial",
                    "summary": "Login is in src/auth.ts:42; logout is not wired.",
                    "report": "## Found\n- src/auth.ts:42",
                    "changedFiles": ["src/auth.ts", "src/auth.ts"]
                }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["submitted"], true);
        assert_eq!(parsed["replacedEarlier"], false);
        assert!(parsed["hint"].as_str().unwrap().contains("End it now"));
        let held = holder.held.lock().unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].outcome, ReportOutcome::Partial);
        assert_eq!(held[0].changed_files, vec!["src/auth.ts".to_string()], "deduplicated");
    }

    #[tokio::test]
    async fn outcome_summary_and_report_are_required() {
        let holder = Arc::new(Holder::default());
        let tool = SubmitReportTool::new(holder.clone());
        let parent = parent_turn();
        for input in [
            json!({ "summary": "s", "report": "r" }),
            json!({ "outcome": "finished", "summary": "s", "report": "r" }),
            json!({ "outcome": "done", "report": "r" }),
            json!({ "outcome": "done", "summary": "s", "report": "  " }),
        ] {
            let err = tool.execute(input.clone(), &context(&parent)).await.unwrap_err();
            assert!(matches!(err, ToolError::InvalidInput(_)), "{input}");
        }
        assert!(holder.held.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_second_submission_says_it_replaced_the_first() {
        let holder = Arc::new(Holder::default());
        let tool = SubmitReportTool::new(holder.clone());
        let parent = parent_turn();
        let report = json!({ "outcome": "done", "summary": "s", "report": "r", "changedFiles": "a.ts" });
        tool.execute(report.clone(), &context(&parent)).await.unwrap();
        let out = tool.execute(report, &context(&parent)).await.unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["replacedEarlier"], true);
        assert_eq!(holder.held.lock().unwrap()[0].changed_files, vec!["a.ts".to_string()]);
    }
}
