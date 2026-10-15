//! The words a finished child's report arrives in.
//!
//! Two texts, because two readers: the transcript shows one line in the
//! checklist beat's shape, the model reads the report itself with the ids it
//! needs to act on it. Same split as a process ending.
//!
//! A report the child submitted (`submit_report`) arrives as outcome, summary,
//! changed files and the full text, in that order, so the parent can act on
//! the first lines. A run that never submitted is reported from its last
//! message, and says so. A report body longer than [`REPORT_INLINE_MAX`] is
//! moved to a file in the parent's tool-results folder and arrives as a head
//! and tail with the path, the same way any long tool output does: nothing is
//! cut, the middle is one `file_read` away.

use std::path::Path;

use super::host::{SubagentUsage, SubmittedReport};
use super::record::{StopBy, TaskStatus};

/// How a run that did not finish on its own ended: who stopped it, and the
/// last things it did. Empty for a run that ended by itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunEnding<'a> {
    pub stopped_by: Option<StopBy>,
    /// Its last steps from the live stream (`ActivityLog::recent`), shown
    /// when it ended without submitting: the work it had done is otherwise
    /// invisible, because an unfinished thought is never written to its file.
    pub recent: &'a [String],
    /// Which run this is, and the task it was given. From the second run on,
    /// the report names that task: the agent keeps its title (its identity)
    /// for life, so "Fix truncate bug" headed the report of the run that
    /// fixed `div`, and nothing said which follow-up it answered.
    pub run: Option<(u32, &'a str)>,
    /// The parent's OTHER agents still running when this report is handed
    /// in, by the name the parent gave them. `Some(&[])` means this was the
    /// last one; `None` means it was not looked up (nothing is said).
    ///
    /// Said in the report because the parent otherwise has to keep count:
    /// on 2026-10-12 a parent with four explorers out reasoned at length, at
    /// each report, about whether it was allowed to end its turn — and filled
    /// the wait by re-reading files an agent was already mapping.
    pub still_running: Option<&'a [String]>,
}

/// The line that tells the parent where the rest of its agents stand.
fn running_line(others: &[String]) -> String {
    match others {
        [] => "No other agents are running: this was the last report.\n".to_string(),
        [one] => format!(
            "Still running: {one}. Its report starts you again — if nothing can be done until \
             it arrives, say so in one line and end your turn.\n"
        ),
        many => format!(
            "Still running: {} ({}). Their reports start you again — if nothing can be done \
             until they arrive, say so in one line and end your turn.\n",
            many.join(", "),
            many.len()
        ),
    }
}

/// Longest excerpt of a resumed run's task in its report.
const RUN_TASK_CHARS: usize = 160;

/// The line that says who stopped a killed run, and what that asks of the
/// parent.
fn stop_line(by: Option<StopBy>) -> &'static str {
    match by {
        Some(StopBy::User) => {
            "The user stopped it. Do not restart it, resume it or redo its work unless the user \
             asks you to; if its task still matters, say what is left and let them decide.\n"
        }
        Some(StopBy::Parent) => "You stopped it with stop_agent.\n",
        Some(StopBy::WindowClosed) => "It was stopped because the Aurora window closed.\n",
        Some(StopBy::ParentDeleted) => "It was stopped because its parent conversation was deleted.\n",
        None => "It was stopped when your turn was stopped.\n",
    }
}

/// Longest report body delivered whole. Above it the body is moved to a file.
///
/// Higher than the 12 KiB a tool's output spills at: a report is the work
/// product, written for the parent, not a log it skims. The research reports
/// of the 2026-10-08 live run were 13–15 KB and should arrive whole; a 40 KB
/// one would cost the parent's context more than a file read does.
pub const REPORT_INLINE_MAX: usize = 16 * 1024;

/// What a run left for its parent.
#[derive(Debug, Clone, Copy)]
pub enum ReportBody<'a> {
    /// Handed in with `submit_report`.
    Submitted(&'a SubmittedReport),
    /// It ended without submitting: its last message, or the best partial
    /// answer of a run that failed or was stopped.
    LastMessage(&'a str),
}

/// Where a long report body goes, and under what name.
#[derive(Debug, Clone, Copy)]
pub struct ReportFile<'a> {
    /// The parent thread's tool-results folder, which the parent's
    /// `file_read` can always open.
    pub dir: &'a Path,
    /// File name, without a directory.
    pub name: &'a str,
}

/// `text` whole, or a head and tail with the path of a file holding all of
/// it when it is longer than [`REPORT_INLINE_MAX`] and the file can be
/// written. A failed write keeps the text whole: too long beats lost.
fn inline_or_file(text: &str, file: Option<ReportFile<'_>>) -> String {
    let text = text.trim();
    if text.len() <= REPORT_INLINE_MAX {
        return text.to_string();
    }
    file.and_then(|f| crate::agent_runtime::tool_spill::spill_document(f.dir, f.name, text))
        .unwrap_or_else(|| text.to_string())
}

/// What the parent conversation is told when a background child ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// The transcript's one line: `Finished "Find the login flow" · completed`.
    pub summary: String,
    /// What the model reads.
    pub detail: String,
}

fn verb(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Completed => "Finished",
        TaskStatus::Failed => "Failed",
        TaskStatus::Killed => "Stopped",
        TaskStatus::Running => "Running",
    }
}

fn duration(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// Build the report for one finished run.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn build(
    agent_id: &str,
    name: Option<&str>,
    agent_type: &str,
    description: &str,
    status: TaskStatus,
    body: ReportBody<'_>,
    error: Option<&str>,
    usage: &SubagentUsage,
    output_file: &str,
    file: Option<ReportFile<'_>>,
    ending: RunEnding<'_>,
) -> Report {
    let summary = format!("{} \"{description}\" · {}", verb(status), status.as_str());

    let handle = name.map_or_else(|| agent_id.to_string(), |n| format!("{n} ({agent_id})"));
    let outcome_attr = match body {
        ReportBody::Submitted(r) => format!(" outcome=\"{}\"", r.outcome.as_str()),
        // Stopped is not "never handed in": nobody asked it for a report.
        ReportBody::LastMessage(_) if status == TaskStatus::Killed => {
            " outcome=\"stopped\"".to_string()
        }
        ReportBody::LastMessage(_) => " outcome=\"not_submitted\"".to_string(),
    };
    let mut detail = format!(
        "<subagent_report agent=\"{handle}\" type=\"{agent_type}\" status=\"{}\"{outcome_attr}>\n",
        status.as_str()
    );
    detail.push_str(&format!(
        "Sub-agent \"{description}\" {} after {} · {} tool call{} · {} tokens.\n",
        status.as_str(),
        duration(usage.duration_ms),
        usage.tool_calls,
        if usage.tool_calls == 1 { "" } else { "s" },
        usage.total_tokens(),
    ));
    if let Some((run, task)) = ending.run.filter(|(run, _)| *run > 1) {
        let task = super::activity::excerpt(task, RUN_TASK_CHARS);
        if !task.is_empty() {
            detail.push_str(&format!("Run {run} · task: {task}\n"));
        }
    }
    if let Some(error) = error.map(str::trim).filter(|e| !e.is_empty()) {
        detail.push_str(&format!("Error: {error}\n"));
    }
    if status == TaskStatus::Killed {
        detail.push_str(stop_line(ending.stopped_by));
    }
    match body {
        ReportBody::Submitted(report) => {
            detail.push_str(&format!("Outcome: {}\n", report.outcome.as_str()));
            detail.push_str(&format!("Summary: {}\n", report.summary.trim()));
            if !report.changed_files.is_empty() {
                detail.push_str(&format!(
                    "Changed files: {}\n",
                    report.changed_files.join(", ")
                ));
            }
            detail.push_str("\nReport:\n");
            detail.push_str(&inline_or_file(&report.report, file));
            detail.push('\n');
        }
        ReportBody::LastMessage(text) if text.trim().is_empty() => {
            detail.push_str(match status {
                TaskStatus::Killed => "It was stopped before it submitted a report.\n",
                _ => "It ended without a report or a final message.\n",
            });
        }
        ReportBody::LastMessage(text) => {
            detail.push_str(match status {
                TaskStatus::Completed => {
                    "It did not submit a report with submit_report, even when asked. Its last \
                     message follows; check it before relying on it.\n"
                }
                TaskStatus::Killed => {
                    "It was stopped before it submitted a report. What it had said follows.\n"
                }
                _ => "It ended before submitting a report. What it had said follows.\n",
            });
            detail.push_str("\nLast message:\n");
            detail.push_str(&inline_or_file(text, file));
            detail.push('\n');
        }
    }
    // A run that ended without a report still did work; say what, from its
    // own stream. Its claims, not checked: it never got to verify them.
    if matches!(body, ReportBody::LastMessage(_))
        && status != TaskStatus::Completed
        && !ending.recent.is_empty()
    {
        detail.push_str("\nWhat it was doing when it ended (its own steps, unverified):\n");
        for line in ending.recent {
            detail.push_str("- ");
            detail.push_str(line);
            detail.push('\n');
        }
    }
    if let Some(others) = ending.still_running {
        detail.push('\n');
        detail.push_str(&running_line(others));
    }
    detail.push_str(&format!("\nTranscript: {output_file}\n"));
    detail.push_str(&format!(
        "To continue this agent with more work, call send_message with to=\"{}\" and kind=\"task\". Use kind=\"message\" for conversation or thanks, which does not require another work report.\n",
        name.unwrap_or(agent_id)
    ));
    detail.push_str("</subagent_report>");
    Report { summary, detail }
}

/// Build a child's MID-RUN message to its parent (`message_parent`). Same two
/// readers as a finish report; the status is `running`, which is how the
/// window knows this is a message and not an ending.
#[must_use]
pub fn message(
    agent_id: &str,
    name: Option<&str>,
    agent_type: &str,
    description: &str,
    text: &str,
    waiting: bool,
) -> Report {
    message_with_kind(agent_id, name, agent_type, description, text,
        if waiting { super::messaging::ChildMessageKind::Question } else { super::messaging::ChildMessageKind::Message }, waiting)
}

pub fn message_with_kind(
    agent_id: &str,
    name: Option<&str>,
    agent_type: &str,
    description: &str,
    text: &str,
    kind: super::messaging::ChildMessageKind,
    waiting: bool,
) -> Report {
    let handle = name.map_or_else(|| agent_id.to_string(), |n| format!("{n} ({agent_id})"));
    let who = name.unwrap_or(description);
    let to = name.unwrap_or(agent_id);
    let label = match kind {
        super::messaging::ChildMessageKind::Question => "Question",
        super::messaging::ChildMessageKind::Message => "Message",
        super::messaging::ChildMessageKind::Reply => "Reply",
    };
    let summary = format!("{label} from \"{who}\"");
    let waiting_attr = if waiting { " waiting=\"true\"" } else { "" };
    let mut detail = format!(
        "<subagent_message agent=\"{handle}\" type=\"{agent_type}\" status=\"running\"{waiting_attr} kind=\"{}\">\n", kind.as_str()
    );
    if waiting {
        detail.push_str(&format!(
            "Sub-agent \"{description}\" is paused, waiting for your answer, and asks:\n\n{}\n\n",
            text.trim()
        ));
        detail.push_str(&format!(
            "It cannot ask the user. Answer it with send_message to=\"{to}\" kind=\"reply\" now: it is holding \
             for your reply for up to {} minutes, and your answer reaches it at once. Without \
             an answer it carries on with what it can.\n",
            super::WAIT_FOR_REPLY_SECS / 60
        ));
    } else {
        detail.push_str(&format!(
            "Sub-agent \"{description}\" is still working and says:\n\n{}\n\n",
            text.trim()
        ));
        detail.push_str(&format!(
            "It cannot ask the user. Answer it with send_message to=\"{to}\" kind=\"reply\" if it asked a question; otherwise no reply is required. It keeps working \
             meanwhile and will still send its report when it finishes.\n"
        ));
    }
    detail.push_str("</subagent_message>");
    Report { summary, detail }
}

/// A finished child can answer a message without submitting its old work again.
pub fn conversation_reply(agent_id: &str, name: Option<&str>, agent_type: &str, description: &str, text: &str) -> Report {
    let who = name.unwrap_or(description);
    let handle = name.map_or_else(|| agent_id.to_string(), |n| format!("{n} ({agent_id})"));
    Report {
        summary: format!("Reply from \"{who}\""),
        detail: format!("<subagent_message agent=\"{handle}\" type=\"{agent_type}\" kind=\"reply\">\nSub-agent \"{description}\" replies to your message:\n\n{}\n\nThis is a conversation reply, not a new work report. No response is required unless it asks a question.\n</subagent_message>", text.trim()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mid_run_message_names_the_agent_and_how_to_answer() {
        let r = message("agent_9", Some("scout"), "explore", "Find things", "I have no shell tool.", false);
        assert_eq!(r.summary, "Message from \"scout\"");
        assert!(r.detail.starts_with("<subagent_message agent=\"scout (agent_9)\""));
        assert!(r.detail.contains("status=\"running\""));
        assert!(!r.detail.contains("waiting="));
        assert!(r.detail.contains("I have no shell tool."));
        assert!(r.detail.contains("send_message to=\"scout\""));
        let unnamed = message("agent_9", None, "explore", "Find things", "x", false);
        assert_eq!(unnamed.summary, "Message from \"Find things\"");
        assert!(unnamed.detail.contains("to=\"agent_9\""));
    }

    #[test]
    fn a_waiting_question_tells_the_parent_to_answer_now() {
        let r = message("agent_9", Some("prober"), "explore", "Probe", "No shell. Skip the versions?", true);
        assert_eq!(r.summary, "Question from \"prober\"");
        assert!(r.detail.contains("waiting=\"true\""));
        assert!(r.detail.contains("is paused, waiting for your answer"));
        assert!(r.detail.contains("send_message to=\"prober\" kind=\"reply\" now"));
        assert!(r.detail.contains("up to 2 minutes"));
        // The window strips this line from the card by its opening words.
        assert!(r.detail.contains("\nIt cannot ask the user. Answer it with send_message"));
    }

    #[test]
    fn a_resumed_run_names_its_own_task_under_the_unchanged_title() {
        let usage = SubagentUsage::default();
        let report = submitted("fixed");
        let follow_up = "Now fix the division-by-zero bug in app/math.js div (throw an Error).";
        let second = build(
            "agent_1",
            Some("fixer"),
            "general-purpose",
            "Fix truncate bug",
            TaskStatus::Completed,
            ReportBody::Submitted(&report),
            None,
            &usage,
            "p",
            None,
            RunEnding {
                run: Some((2, follow_up)),
                ..RunEnding::default()
            },
        );
        assert_eq!(second.summary, "Finished \"Fix truncate bug\" · completed", "title kept");
        assert!(second.detail.contains(&format!("Run 2 · task: {follow_up}")), "{}", second.detail);

        // The first run's task IS the title; no line for it.
        let first = build(
            "agent_1",
            Some("fixer"),
            "general-purpose",
            "Fix truncate bug",
            TaskStatus::Completed,
            ReportBody::Submitted(&report),
            None,
            &usage,
            "p",
            None,
            RunEnding {
                run: Some((1, "Find and fix the bug in truncate")),
                ..RunEnding::default()
            },
        );
        assert!(!first.detail.contains("Run 1"));
    }

    use super::super::host::ReportOutcome;

    fn submitted(report: &str) -> SubmittedReport {
        SubmittedReport {
            outcome: ReportOutcome::Partial,
            summary: "Login is in src/auth.ts:42; logout is not wired.".into(),
            report: report.into(),
            changed_files: vec!["src/auth.ts".into(), "src/session.ts".into()],
        }
    }

    #[test]
    fn a_submitted_report_leads_with_outcome_summary_and_files() {
        let report = submitted("## Found\n- src/auth.ts:42");
        let r = build(
            "agent_1",
            Some("scout"),
            "explore",
            "Find the login flow",
            TaskStatus::Completed,
            ReportBody::Submitted(&report),
            None,
            &SubagentUsage {
                input_tokens: 8_000,
                output_tokens: 421,
                tool_calls: 12,
                iterations: 5,
                duration_ms: 91_000,
            },
            "C:/x/agents/agent_1/conversation.jsonl",
            None,
            RunEnding::default(),
        );
        assert_eq!(r.summary, "Finished \"Find the login flow\" · completed");
        assert!(r
            .detail
            .starts_with("<subagent_report agent=\"scout (agent_1)\" type=\"explore\" status=\"completed\" outcome=\"partial\">"));
        assert!(r.detail.contains("after 1m 31s · 12 tool calls · 8421 tokens"));
        let outcome = r.detail.find("Outcome: partial").unwrap();
        let summary = r.detail.find("Summary: Login is in src/auth.ts:42").unwrap();
        let files = r.detail.find("Changed files: src/auth.ts, src/session.ts").unwrap();
        let body = r.detail.find("## Found").unwrap();
        assert!(outcome < summary && summary < files && files < body, "{}", r.detail);
        assert!(r.detail.contains("Transcript: C:/x/agents/agent_1/conversation.jsonl"));
        assert!(r.detail.contains("send_message with to=\"scout\""));
        assert!(r.detail.ends_with("</subagent_report>"));
    }

    /// The parent should not have to keep count of its agents: each report
    /// names the ones still out, or says it was the last.
    #[test]
    fn a_report_says_which_agents_are_still_running_or_that_it_was_the_last() {
        let report = submitted("## Found");
        let others = vec!["cloud-arch".to_string(), "web-admin".to_string()];
        let with_two = build(
            "agent_1",
            Some("client-arch"),
            "explore",
            "Map the client",
            TaskStatus::Completed,
            ReportBody::Submitted(&report),
            None,
            &SubagentUsage::default(),
            "p",
            None,
            RunEnding { still_running: Some(&others), ..RunEnding::default() },
        );
        assert!(with_two.detail.contains("Still running: cloud-arch, web-admin (2)."), "{}", with_two.detail);
        assert!(with_two.detail.contains("say so in one line and end your turn"));

        let one = vec!["web-admin".to_string()];
        let with_one = build(
            "agent_1", Some("client-arch"), "explore", "Map the client", TaskStatus::Completed,
            ReportBody::Submitted(&report), None, &SubagentUsage::default(), "p", None,
            RunEnding { still_running: Some(&one), ..RunEnding::default() },
        );
        assert!(with_one.detail.contains("Still running: web-admin. Its report starts you again"));

        let last = build(
            "agent_1", Some("client-arch"), "explore", "Map the client", TaskStatus::Completed,
            ReportBody::Submitted(&report), None, &SubagentUsage::default(), "p", None,
            RunEnding { still_running: Some(&[]), ..RunEnding::default() },
        );
        assert!(last.detail.contains("No other agents are running: this was the last report."));

        // Not looked up (a foreground run, a test): nothing is said.
        let unknown = build(
            "agent_1", Some("client-arch"), "explore", "Map the client", TaskStatus::Completed,
            ReportBody::Submitted(&report), None, &SubagentUsage::default(), "p", None,
            RunEnding::default(),
        );
        assert!(!unknown.detail.contains("Still running") && !unknown.detail.contains("last report"));
    }

    #[test]
    fn a_run_that_never_submitted_says_so_and_carries_its_last_message() {
        let r = build(
            "agent_1",
            None,
            "explore",
            "Job",
            TaskStatus::Completed,
            ReportBody::LastMessage("Login is in src/auth.ts:42."),
            None,
            &SubagentUsage::default(),
            "p",
            None,
            RunEnding::default(),
        );
        assert!(r.detail.contains("outcome=\"not_submitted\""));
        assert!(r.detail.contains("did not submit a report"));
        assert!(r.detail.contains("Last message:\nLogin is in src/auth.ts:42."));
    }

    /// Live run 5: the user pressed Stop on `inventory` after four minutes.
    /// The parent read "0 tool calls · 0 tokens · stopped before it reported
    /// anything", the same words whoever had stopped it.
    #[test]
    fn a_stopped_agent_says_who_stopped_it_and_what_it_was_doing() {
        let recent = vec![
            "ran file_read data/catalog.txt".to_string(),
            "was thinking: Summing the garden prices".to_string(),
        ];
        let r = build(
            "agent_2",
            Some("inventory"),
            "explore",
            "Long job",
            TaskStatus::Killed,
            ReportBody::LastMessage(""),
            None,
            &SubagentUsage {
                input_tokens: 40_000,
                output_tokens: 9_000,
                tool_calls: 2,
                iterations: 3,
                duration_ms: 241_000,
            },
            "p",
            None,
            RunEnding {
                stopped_by: Some(StopBy::User),
                recent: &recent,
                run: None,
                still_running: None,
            },
        );
        assert_eq!(r.summary, "Stopped \"Long job\" · killed");
        assert!(r.detail.contains("outcome=\"stopped\""), "{}", r.detail);
        assert!(r.detail.contains("The user stopped it. Do not restart it"), "{}", r.detail);
        assert!(r.detail.contains("2 tool calls · 49000 tokens"), "{}", r.detail);
        assert!(r.detail.contains("- ran file_read data/catalog.txt"));
        assert!(r.detail.contains("- was thinking: Summing the garden prices"));
        assert!(r.detail.contains("to=\"inventory\""));

        let by_parent = build(
            "agent_2",
            None,
            "explore",
            "Long job",
            TaskStatus::Killed,
            ReportBody::LastMessage(""),
            None,
            &SubagentUsage::default(),
            "p",
            None,
            RunEnding {
                stopped_by: Some(StopBy::Parent),
                recent: &[],
                run: None,
                still_running: None,
            },
        );
        assert!(by_parent.detail.contains("You stopped it with stop_agent."));
        assert!(!by_parent.detail.contains("The user stopped it"));
        assert!(!by_parent.detail.contains("What it was doing"), "nothing to list");
    }

    #[test]
    fn a_failed_agent_keeps_what_it_said() {
        let f = build(
            "agent_3",
            None,
            "general-purpose",
            "Job",
            TaskStatus::Failed,
            ReportBody::LastMessage("partial"),
            Some("provider said no"),
            &SubagentUsage::default(),
            "p",
            None,
            RunEnding::default(),
        );
        assert!(f.detail.contains("Error: provider said no"));
        assert!(f.detail.contains("ended before submitting"));
        assert!(f.detail.contains("partial"), "partial beats silent");
    }

    #[test]
    fn a_long_report_moves_to_a_file_and_keeps_its_head_and_tail() {
        let dir = tempfile::tempdir().unwrap();
        let long = format!("HEAD-MARK\n{}\nTAIL-MARK", "middle line\n".repeat(4_000));
        let report = submitted(&long);
        let r = build(
            "agent_1",
            Some("scout"),
            "explore",
            "Job",
            TaskStatus::Completed,
            ReportBody::Submitted(&report),
            None,
            &SubagentUsage::default(),
            "p",
            Some(ReportFile {
                dir: dir.path(),
                name: "agent-report-agent_1-1.md",
            }),
            RunEnding::default(),
        );
        assert!(r.detail.len() < long.len(), "the middle left the message");
        assert!(r.detail.contains("HEAD-MARK") && r.detail.contains("TAIL-MARK"));
        assert!(r.detail.contains("Summary: Login is in"), "the summary stays whole");
        let written = std::fs::read_to_string(dir.path().join("agent-report-agent_1-1.md")).unwrap();
        assert_eq!(written, long.trim(), "nothing is lost: the file holds all of it");
        assert!(r.detail.contains("agent-report-agent_1-1.md"), "the path is given");

        // At or under the limit it stays whole and no file is written.
        let short = submitted("short");
        let dir2 = tempfile::tempdir().unwrap();
        let r = build(
            "agent_1",
            None,
            "explore",
            "Job",
            TaskStatus::Completed,
            ReportBody::Submitted(&short),
            None,
            &SubagentUsage::default(),
            "p",
            Some(ReportFile {
                dir: dir2.path(),
                name: "agent-report-agent_1-1.md",
            }),
            RunEnding::default(),
        );
        assert!(r.detail.contains("Report:\nshort\n"));
        assert!(!dir2.path().join("agent-report-agent_1-1.md").exists());
    }
}
