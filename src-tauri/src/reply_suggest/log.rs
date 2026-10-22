//! What reply suggestions did, written down for analysis.
//!
//! Nothing in the app reads these files back except [`recent_outcomes`]; they
//! exist so the suggestions can be judged against what the developer actually
//! sent, days later, and the instruction fixed from evidence.
//!
//! - `<conversation folder>/suggestions.jsonl` — one `run` line per suggestion
//!   request (what the model was given, what it thought, what it answered, what
//!   the chips showed, cost and time) and one `outcome` line per message the
//!   developer sent after chips were offered (which chip they tapped, whether
//!   they changed it, or what they typed instead).
//! - `<project folder>/suggestion-outcomes.jsonl` — the outcomes alone, small,
//!   across every conversation in the project. The cloud model reads its tail
//!   as examples of how this developer responds to suggestions.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Per-conversation log file name.
pub const RUN_LOG: &str = "suggestions.jsonl";
/// Per-project outcome file name.
pub const OUTCOME_LOG: &str = "suggestion-outcomes.jsonl";

/// Appends from two commands can land together; one writer at a time keeps
/// every line whole.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// One suggestion request, start to finish.
#[derive(Debug, Clone, Serialize)]
pub struct RunRecord {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub run_id: String,
    pub at: String,
    pub thread_id: String,
    /// `"cloud"` or `"local"`.
    pub path: &'static str,
    pub model: String,
    /// Which instruction produced this run, so a changed prompt is visible in
    /// the data without storing the whole instruction on every line.
    pub prompt_version: &'static str,
    /// Whether the request asked the model to think. A model can think
    /// without being asked; `thinking` below holds what it produced either way.
    pub thinking_requested: bool,
    /// Exactly what the model read as the user message.
    pub input: String,
    pub input_chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<BriefStats>,
    /// The model's reasoning, when it produced any.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    /// The model's visible text.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub raw_text: String,
    /// The `suggest_replies` arguments, when it called the tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    /// `"tool"`, `"text"` (fell back to reading a list) or `"none"`.
    pub answered_via: &'static str,
    /// What the chips showed, after filtering.
    pub suggestions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the brief held, so a bad suggestion can be traced to missing context.
#[derive(Debug, Clone, Serialize)]
pub struct BriefStats {
    pub turns_total: usize,
    pub turns_included: usize,
    pub compacted: bool,
    pub open_tasks: bool,
    pub past_outcomes: usize,
}

/// What the developer did with a set of chips. Sent by the window when they
/// send their next message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeInput {
    pub run_id: String,
    /// The chips that were offered; empty when the developer sent before they
    /// arrived.
    #[serde(default)]
    pub shown: Vec<String>,
    /// `"tapped"` (sent a chip unchanged), `"tapped_edited"`, `"typed"`
    /// (ignored the chips), `"pasted"` (a log, command or block nobody
    /// could have predicted; never an example) or `"sent_before_ready"`.
    pub action: String,
    #[serde(default)]
    pub tapped_index: Option<usize>,
    pub sent_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OutcomeRecord {
    #[serde(rename = "type")]
    kind: String,
    run_id: String,
    at: String,
    thread_id: String,
    shown: Vec<String>,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tapped_index: Option<usize>,
    sent_text: String,
}

fn append_line(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let _guard = WRITE_LOCK.lock().map_err(|_| "suggestion log lock poisoned".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("{}: {e}", path.display()))
}

/// Append a run to the conversation's log.
pub fn write_run(thread_dir: &Path, record: &RunRecord) -> Result<(), String> {
    append_line(&thread_dir.join(RUN_LOG), record)
}

/// Append an outcome to the conversation's log and to the project's.
pub fn write_outcome(
    thread_dir: &Path,
    project_dir: &Path,
    thread_id: &str,
    outcome: OutcomeInput,
) -> Result<(), String> {
    let record = OutcomeRecord {
        kind: "outcome".into(),
        run_id: outcome.run_id,
        at: chrono::Utc::now().to_rfc3339(),
        thread_id: thread_id.into(),
        shown: outcome.shown,
        action: outcome.action,
        tapped_index: outcome.tapped_index,
        sent_text: outcome.sent_text,
    };
    append_line(&thread_dir.join(RUN_LOG), &record)?;
    append_line(&project_dir.join(OUTCOME_LOG), &record)
}

/// How many past outcomes the cloud model sees.
pub const OUTCOME_EXAMPLES: usize = 8;
/// A sent message longer than this is cut in an example; the point is the
/// direction the developer took, not the whole text.
const OUTCOME_SENT_CHARS: usize = 300;

/// The project's last few outcomes where chips were actually offered, rendered
/// as examples, oldest first. Returns the text and how many it holds. A missing
/// or unreadable file is no examples.
#[must_use]
pub fn recent_outcomes(project_dir: &Path) -> (String, usize) {
    let Ok(file) = fs::File::open(project_dir.join(OUTCOME_LOG)) else {
        return (String::new(), 0);
    };
    let mut kept: std::collections::VecDeque<OutcomeRecord> = std::collections::VecDeque::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(record) = serde_json::from_str::<OutcomeRecord>(&line) else {
            continue;
        };
        if record.shown.is_empty() {
            continue;
        }
        // A pasted log or command says nothing about what the developer
        // would have typed; as an example it taught the model otherwise.
        if record.action == "pasted" {
            continue;
        }
        kept.push_back(record);
        if kept.len() > OUTCOME_EXAMPLES {
            kept.pop_front();
        }
    }
    let text = kept
        .iter()
        .map(|r| {
            let what = match (r.action.as_str(), r.tapped_index) {
                ("tapped", Some(i)) => format!("tapped suggestion {} unchanged", i + 1),
                ("tapped_edited", Some(i)) => format!("tapped suggestion {}, then changed it", i + 1),
                _ => "ignored them and typed their own".to_string(),
            };
            let sent: String = r.sent_text.chars().take(OUTCOME_SENT_CHARS).collect();
            format!(
                "Suggested: {}\nThey {what}: {}",
                r.shown.join(" | "),
                sent.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (text, kept.len())
}

/// The conversation's unfinished checklist tasks, one per line. A missing or
/// unreadable checklist is none.
#[must_use]
pub fn open_tasks(thread_dir: &Path) -> String {
    let Ok(raw) = fs::read_to_string(thread_dir.join("todos.json")) else {
        return String::new();
    };
    let Ok(list) = serde_json::from_str::<Value>(&raw) else {
        return String::new();
    };
    let Some(items) = list.get("items").and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let status = item.get("status")?.as_str()?;
            let content = item.get("content")?.as_str()?;
            match status {
                "pending" => Some(format!("- [ ] {content}")),
                "in_progress" => Some(format!("- [~] {content} (in progress)")),
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(run: &str, shown: &[&str], action: &str, tapped: Option<usize>, sent: &str) -> OutcomeInput {
        OutcomeInput {
            run_id: run.into(),
            shown: shown.iter().map(|s| (*s).to_string()).collect(),
            action: action.into(),
            tapped_index: tapped,
            sent_text: sent.into(),
        }
    }

    #[test]
    fn an_outcome_lands_in_the_conversation_and_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("thread-1");
        write_outcome(&thread, dir.path(), "thread-1", outcome("r1", &["Yes", "No"], "tapped", Some(0), "Yes"))
            .unwrap();
        let conversation = fs::read_to_string(thread.join(RUN_LOG)).unwrap();
        let project = fs::read_to_string(dir.path().join(OUTCOME_LOG)).unwrap();
        assert!(conversation.contains("\"type\":\"outcome\""));
        assert!(project.contains("\"run_id\":\"r1\""));
    }

    #[test]
    fn recent_outcomes_read_as_examples_and_skip_ones_with_no_chips() {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("t");
        write_outcome(&thread, dir.path(), "t", outcome("r1", &[], "sent_before_ready", None, "go")).unwrap();
        write_outcome(
            &thread,
            dir.path(),
            "t",
            outcome("r2", &["Run the tests", "Show the diff"], "typed", None, "fix it professionally, don't ask me"),
        )
        .unwrap();
        write_outcome(&thread, dir.path(), "t", outcome("r3", &["Yes, do it"], "tapped_edited", Some(0), "yes do it now"))
            .unwrap();
        let (text, count) = recent_outcomes(dir.path());
        assert_eq!(count, 2);
        assert!(text.contains("Suggested: Run the tests | Show the diff"));
        assert!(text.contains("ignored them and typed their own: fix it professionally, don't ask me"));
        assert!(text.contains("tapped suggestion 1, then changed it: yes do it now"));
    }

    /// A pasted terminal log is recorded, but the brief must not show it as
    /// what the developer typed instead.
    #[test]
    fn a_pasted_send_is_kept_out_of_the_examples() {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("t");
        write_outcome(
            &thread,
            dir.path(),
            "t",
            outcome("r1", &["Run the tests"], "pasted", None, "T /portal/billing 200 in 59ms\n[browser] Detected"),
        )
        .unwrap();
        write_outcome(&thread, dir.path(), "t", outcome("r2", &["Show the diff"], "typed", None, "check new package"))
            .unwrap();
        let (text, count) = recent_outcomes(dir.path());
        assert_eq!(count, 1);
        assert!(!text.contains("portal/billing"));
        assert!(text.contains("check new package"));
        assert!(fs::read_to_string(dir.path().join(OUTCOME_LOG)).unwrap().contains("\"pasted\""));
    }

    #[test]
    fn only_the_last_few_outcomes_are_examples() {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("t");
        for i in 0..20 {
            write_outcome(&thread, dir.path(), "t", outcome(&format!("r{i}"), &["a"], "typed", None, &format!("msg{i}")))
                .unwrap();
        }
        let (text, count) = recent_outcomes(dir.path());
        assert_eq!(count, OUTCOME_EXAMPLES);
        assert!(text.contains("msg19"));
        assert!(!text.contains("msg11\n"));
        assert!(!text.contains(": msg0"));
    }

    #[test]
    fn open_tasks_lists_only_unfinished_ones() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("todos.json"),
            r#"{"items":[
                {"id":"1","content":"Fix login","activeForm":"Fixing","status":"completed"},
                {"id":"2","content":"Guard signup","activeForm":"Guarding","status":"in_progress"},
                {"id":"3","content":"Add a test","activeForm":"Adding","status":"pending"}
            ]}"#,
        )
        .unwrap();
        let text = open_tasks(dir.path());
        assert!(!text.contains("Fix login"));
        assert!(text.contains("- [~] Guard signup (in progress)"));
        assert!(text.contains("- [ ] Add a test"));
    }

    #[test]
    fn a_missing_checklist_or_outcome_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(open_tasks(dir.path()), "");
        assert_eq!(recent_outcomes(dir.path()), (String::new(), 0));
    }
}
