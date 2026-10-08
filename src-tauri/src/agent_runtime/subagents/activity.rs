//! A running sub-agent's work as it happens, for a parent that checks on it.
//!
//! Fed from the child's own event stream (every thinking delta, text delta,
//! tool call and injected message the window sees), never from its session.
//! The session is locked by the child's turn for the whole run, so anything
//! that reads it waits for the run to end; a progress check that waited for
//! the end was the "Check agent ran for 1m 54s" card.
//!
//! What it keeps is the SHAPE of the work: which tools were called and on
//! what, what the agent thought, what it said, which messages reached it.
//! Never a tool's result: the parent asks "what is it doing", and the answer
//! must not drag the child's transcript into the parent's context.

use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::InjectedOrigin;

/// Entries kept per agent. Older ones are dropped and counted, so a check
/// after a long silence still says how much it is not showing.
const MAX_ENTRIES: usize = 400;
/// Longest thought or reply one entry keeps.
const MAX_ENTRY_CHARS: usize = 2_000;
/// What a check shows of one thought or reply.
pub const CHECK_TEXT_CHARS: usize = 320;
/// What a check shows of a tool call's subject.
const CHECK_SUBJECT_CHARS: usize = 80;
/// Lines one check returns at most; the oldest unseen ones are counted
/// instead.
pub const CHECK_MAX_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    Tool,
    Thought,
    Said,
    /// A message that reached the agent mid-run: from the parent, or a
    /// background process ending.
    Received,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEntry {
    pub seq: u64,
    pub kind: ActivityKind,
    pub text: String,
}

/// The digest one check returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckDigest {
    /// Everything since the previous check, oldest first, one line each.
    pub timeline: Vec<String>,
    /// Unseen entries left out because the timeline is capped.
    pub omitted: usize,
    /// The thought or reply being produced right now, not yet finished.
    pub in_progress: Option<String>,
    pub steps: usize,
    pub tool_calls: usize,
}

/// What a stream has shown so far, counted. Cumulative over the record's
/// life; subtract a reading taken at a run's start for that run alone.
///
/// A finished turn reports its usage to the run directly. A turn that was
/// stopped or failed never does, so a stopped run reported "0 tool calls,
/// 0 tokens" after four minutes of work. These counts come from the stream
/// and are there whatever the ending.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActivityTotals {
    pub steps: usize,
    pub tool_calls: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl ActivityTotals {
    /// What happened between `earlier` and `self`.
    #[must_use]
    pub fn since(&self, earlier: &Self) -> Self {
        Self {
            steps: self.steps.saturating_sub(earlier.steps),
            tool_calls: self.tool_calls.saturating_sub(earlier.tool_calls),
            input_tokens: self.input_tokens.saturating_sub(earlier.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(earlier.output_tokens),
        }
    }
}

#[derive(Debug, Default)]
pub struct ActivityLog {
    entries: std::collections::VecDeque<ActivityEntry>,
    next_seq: u64,
    /// The highest seq a check has returned.
    checked_through: u64,
    /// The thought or reply still streaming.
    open: Option<(ActivityKind, String)>,
    steps: usize,
    tool_calls: usize,
    /// The prompt size of the latest model call: what the agent's context
    /// holds right now.
    context_tokens: Option<u64>,
    /// Tokens of model calls that have ended (input, output).
    tokens_done: (u64, u64),
    /// The latest usage reported for the call in progress. Replaced, not
    /// added, so a provider that reports usage more than once per call is
    /// not counted twice; folded into `tokens_done` when the next call
    /// starts.
    tokens_open: Option<(u64, u64)>,
}

impl ActivityLog {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one event from the child's stream in.
    pub fn observe(&mut self, event: &AssistantEvent) {
        match event {
            AssistantEvent::StreamAttemptStarted => {
                self.close_open();
                self.steps += 1;
                if let Some((input, output)) = self.tokens_open.take() {
                    self.tokens_done.0 += input;
                    self.tokens_done.1 += output;
                }
            }
            AssistantEvent::Thinking { text, .. } => self.extend(ActivityKind::Thought, text),
            AssistantEvent::TextDelta { delta } => self.extend(ActivityKind::Said, delta),
            AssistantEvent::ToolUse { name, input, .. } => {
                self.close_open();
                self.tool_calls += 1;
                self.push(ActivityKind::Tool, describe_tool_call(name, input));
            }
            AssistantEvent::QueuedMessageInjected { text, origin, .. } => {
                self.close_open();
                let who = match origin {
                    InjectedOrigin::Process => "process",
                    _ => "you",
                };
                self.push(ActivityKind::Received, format!("{who}: {}", text.trim()));
            }
            AssistantEvent::PartialReplyDiscarded { .. } => {
                // The reply restarts from its first token; the fragment never
                // happened as far as the conversation is concerned.
                self.open = None;
            }
            AssistantEvent::Usage(usage) => {
                let prompt = u64::from(usage.input_tokens)
                    + u64::from(usage.cache_read_input_tokens.unwrap_or(0))
                    + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
                if prompt > 0 {
                    self.context_tokens = Some(prompt);
                }
                // Same measure a finished turn reports (`SubagentUsage::from_turn`).
                self.tokens_open = Some((u64::from(usage.input_tokens), u64::from(usage.output_tokens)));
            }
            AssistantEvent::MessageStop { .. } => self.close_open(),
            _ => {}
        }
    }

    /// The prompt size of the latest model call.
    #[must_use]
    pub fn context_tokens(&self) -> Option<u64> {
        self.context_tokens
    }

    /// Everything counted so far.
    #[must_use]
    pub fn totals(&self) -> ActivityTotals {
        let (open_in, open_out) = self.tokens_open.unwrap_or((0, 0));
        ActivityTotals {
            steps: self.steps,
            tool_calls: self.tool_calls,
            input_tokens: self.tokens_done.0 + open_in,
            output_tokens: self.tokens_done.1 + open_out,
        }
    }

    /// The last `n` entries, oldest first, plus whatever is still streaming.
    /// Does not mark anything seen: this is for a report about a run that
    /// stopped, not for a parent's check.
    #[must_use]
    pub fn recent(&self, n: usize) -> Vec<String> {
        let skip = self.entries.len().saturating_sub(n);
        let mut out: Vec<String> = self.entries.iter().skip(skip).map(render).collect();
        if let Some((kind, text)) = &self.open {
            let text = excerpt(text, CHECK_TEXT_CHARS);
            if !text.is_empty() {
                out.push(match kind {
                    ActivityKind::Thought => format!("was thinking: {text}"),
                    _ => format!("was writing: {text}"),
                });
            }
        }
        out
    }

    /// Everything since the previous check, and mark it seen.
    pub fn take_since_check(&mut self) -> CheckDigest {
        let unseen: Vec<&ActivityEntry> = self
            .entries
            .iter()
            .filter(|e| e.seq > self.checked_through)
            .collect();
        let omitted = unseen.len().saturating_sub(CHECK_MAX_LINES);
        let timeline = unseen
            .iter()
            .skip(omitted)
            .map(|e| render(e))
            .collect::<Vec<_>>();
        if let Some(last) = unseen.last() {
            self.checked_through = last.seq;
        }
        CheckDigest {
            timeline,
            omitted,
            in_progress: self.open.as_ref().and_then(|(kind, text)| {
                let text = excerpt(text, CHECK_TEXT_CHARS);
                (!text.is_empty()).then(|| match kind {
                    ActivityKind::Thought => format!("thinking: {text}"),
                    _ => format!("writing: {text}"),
                })
            }),
            steps: self.steps,
            tool_calls: self.tool_calls,
        }
    }

    fn extend(&mut self, kind: ActivityKind, delta: &str) {
        match &mut self.open {
            Some((open_kind, text)) if *open_kind == kind => {
                if text.chars().count() < MAX_ENTRY_CHARS {
                    text.push_str(delta);
                }
            }
            _ => {
                self.close_open();
                self.open = Some((kind, delta.to_string()));
            }
        }
    }

    fn close_open(&mut self) {
        if let Some((kind, text)) = self.open.take() {
            if !text.trim().is_empty() {
                self.push(kind, text);
            }
        }
    }

    fn push(&mut self, kind: ActivityKind, text: String) {
        self.next_seq += 1;
        let text: String = text.chars().take(MAX_ENTRY_CHARS).collect();
        self.entries.push_back(ActivityEntry {
            seq: self.next_seq,
            kind,
            text,
        });
        while self.entries.len() > MAX_ENTRIES {
            self.entries.pop_front();
        }
    }
}

fn render(entry: &ActivityEntry) -> String {
    match entry.kind {
        ActivityKind::Tool => format!("ran {}", entry.text),
        ActivityKind::Thought => format!("thought: {}", excerpt(&entry.text, CHECK_TEXT_CHARS)),
        ActivityKind::Said => format!("said: {}", excerpt(&entry.text, CHECK_TEXT_CHARS)),
        ActivityKind::Received => {
            format!("received from {}", excerpt(&entry.text, CHECK_TEXT_CHARS))
        }
    }
}

/// `file_read src/auth.ts`, `shell_execute pytest -q`, `grep login`: the tool
/// name plus the first string argument that names its subject.
#[must_use]
pub fn describe_tool_call(name: &str, input: &serde_json::Value) -> String {
    const SUBJECT_KEYS: &[&str] = &[
        "path", "file_path", "command", "pattern", "query", "url", "message", "to", "description",
        "title", "op", "subject",
    ];
    let subject = input.as_object().and_then(|obj| {
        SUBJECT_KEYS
            .iter()
            .find_map(|key| obj.get(*key).and_then(serde_json::Value::as_str))
            .or_else(|| obj.values().find_map(serde_json::Value::as_str))
    });
    match subject.map(|s| excerpt(s, CHECK_SUBJECT_CHARS)) {
        Some(subject) if !subject.is_empty() => format!("{name} {subject}"),
        _ => name.to_string(),
    }
}

/// The first `max` characters of `text` on one line, with an ellipsis when
/// cut.
#[must_use]
pub fn excerpt(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let cut: String = one_line.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thinking(text: &str) -> AssistantEvent {
        AssistantEvent::Thinking {
            text: text.into(),
            signature: None,
        }
    }

    fn tool(name: &str, input: serde_json::Value) -> AssistantEvent {
        AssistantEvent::ToolUse {
            id: format!("t-{name}"),
            name: name.into(),
            input,
        }
    }

    #[test]
    fn a_check_reads_the_work_in_order_and_never_a_result() {
        let mut log = ActivityLog::new();
        log.observe(&AssistantEvent::StreamAttemptStarted);
        log.observe(&tool("file_read", json!({"path": "src/index.css"})));
        log.observe(&AssistantEvent::ToolExecutionResult {
            id: "t-file_read".into(),
            name: "file_read".into(),
            input: json!({}),
            content: "SECRET FILE BODY".into(),
            is_error: false,
        });
        log.observe(&AssistantEvent::StreamAttemptStarted);
        log.observe(&thinking("The header "));
        log.observe(&thinking("uses a grid."));
        log.observe(&tool("file_read", json!({"path": "src/a.ts"})));
        log.observe(&tool("shell_execute", json!({"command": "pnpm test"})));

        let digest = log.take_since_check();
        assert_eq!(
            digest.timeline,
            vec![
                "ran file_read src/index.css",
                "thought: The header uses a grid.",
                "ran file_read src/a.ts",
                "ran shell_execute pnpm test",
            ]
        );
        assert!(digest.timeline.iter().all(|l| !l.contains("SECRET")));
        assert_eq!(digest.steps, 2);
        assert_eq!(digest.tool_calls, 3);
    }

    #[test]
    fn a_second_check_shows_only_what_happened_since_the_first() {
        let mut log = ActivityLog::new();
        log.observe(&tool("glob", json!({"pattern": "**/*.rs"})));
        assert_eq!(log.take_since_check().timeline.len(), 1);

        log.observe(&thinking("Now the tests."));
        log.observe(&AssistantEvent::MessageStop {
            stop_reason: "tool_use".into(),
        });
        let second = log.take_since_check();
        assert_eq!(second.timeline, vec!["thought: Now the tests."]);
        assert!(log.take_since_check().timeline.is_empty());
    }

    #[test]
    fn a_thought_still_streaming_shows_as_in_progress() {
        let mut log = ActivityLog::new();
        log.observe(&thinking("Weighing two approaches"));
        let digest = log.take_since_check();
        assert!(digest.timeline.is_empty());
        assert_eq!(
            digest.in_progress.as_deref(),
            Some("thinking: Weighing two approaches")
        );
    }

    #[test]
    fn a_long_silence_caps_the_timeline_and_counts_the_rest() {
        let mut log = ActivityLog::new();
        for i in 0..(CHECK_MAX_LINES + 5) {
            log.observe(&tool("file_read", json!({"path": format!("f{i}.ts")})));
        }
        let digest = log.take_since_check();
        assert_eq!(digest.timeline.len(), CHECK_MAX_LINES);
        assert_eq!(digest.omitted, 5);
        assert_eq!(digest.timeline[0], "ran file_read f5.ts", "newest kept");
    }

    #[test]
    fn a_discarded_partial_reply_leaves_nothing_behind() {
        let mut log = ActivityLog::new();
        log.observe(&AssistantEvent::TextDelta {
            delta: "half a sen".into(),
        });
        log.observe(&AssistantEvent::PartialReplyDiscarded {
            attempt: 1,
            max_attempts: 3,
            reason: "dropped".into(),
        });
        let digest = log.take_since_check();
        assert!(digest.timeline.is_empty());
        assert!(digest.in_progress.is_none());
    }

    #[test]
    fn totals_count_tokens_once_per_call_and_include_the_call_still_open() {
        let usage = |input: u32, output: u32| {
            AssistantEvent::Usage(crate::agent_runtime::types::TokenUsage {
                input_tokens: input,
                output_tokens: output,
                ..Default::default()
            })
        };
        let mut log = ActivityLog::new();
        log.observe(&AssistantEvent::StreamAttemptStarted);
        log.observe(&usage(100, 5));
        // A provider reporting the same call's usage twice is not doubled.
        log.observe(&usage(100, 20));
        log.observe(&tool("file_read", json!({"path": "a"})));
        let before = log.totals();
        log.observe(&AssistantEvent::StreamAttemptStarted);
        log.observe(&usage(300, 7));
        let total = log.totals();
        assert_eq!(total.steps, 2);
        assert_eq!(total.tool_calls, 1);
        assert_eq!((total.input_tokens, total.output_tokens), (400, 27));
        let run = total.since(&before);
        assert_eq!((run.steps, run.tool_calls, run.input_tokens, run.output_tokens), (1, 0, 300, 7));
    }

    #[test]
    fn recent_work_ends_with_what_was_still_streaming_and_marks_nothing_seen() {
        let mut log = ActivityLog::new();
        log.observe(&tool("file_read", json!({"path": "data/catalog.txt"})));
        log.observe(&thinking("Summing the garden prices"));
        let recent = log.recent(5);
        assert_eq!(
            recent,
            vec!["ran file_read data/catalog.txt", "was thinking: Summing the garden prices"]
        );
        assert_eq!(log.take_since_check().timeline.len(), 1, "a check still sees it");
    }

    #[test]
    fn context_is_the_latest_calls_whole_prompt() {
        let mut log = ActivityLog::new();
        log.observe(&AssistantEvent::Usage(crate::agent_runtime::types::TokenUsage {
            input_tokens: 1_000,
            output_tokens: 50,
            cache_read_input_tokens: Some(20_000),
            ..Default::default()
        }));
        assert_eq!(log.context_tokens(), Some(21_000));
    }
}
