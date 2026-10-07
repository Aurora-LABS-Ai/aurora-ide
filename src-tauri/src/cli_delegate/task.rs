//! The two files a dispatch is made of: the request, and the transcript.
//!
//! Both live in [`crate::paths::cli_tasks_dir`] and are named by the task id:
//!
//! ```text
//! 20260901T142233-7f3a91.task.json    the request  — CLI writes, app claims
//! 20260901T142233-7f3a91.jsonl        the record   — app appends, CLI tails
//! ```
//!
//! ## These types are a public contract
//!
//! [`TaskEvent`] is deliberately **not** [`crate::agent_runtime::events::AssistantEvent`],
//! even though the app maps one onto the other. `AssistantEvent` is an internal
//! enum that changes whenever the runtime grows a capability — it carries
//! provider reasoning signatures, per-chunk argument deltas, and other things
//! that exist to drive Aurora's own UI.
//!
//! The transcript is read by other programs. Its shape is the reason the
//! feature is useful, so it gets a narrow, stable, documented vocabulary that
//! the runtime is free to change underneath. The mapping is one function
//! ([`TaskEvent::from_assistant_event`]) and that is the only place a runtime
//! change can reach the file format.
//!
//! The line shape mirrors what `claude -p --output-format stream-json` emits
//! (`thirdparty/claude-code-cli/src/cli/print.ts`): one JSON object per line,
//! a `type` discriminator, and a terminal `result` line carrying the outcome.
//! Anything already written to drive Claude Code headlessly can drive this.

use serde::{Deserialize, Serialize};

/// Format version of both files, bumped when a field changes meaning.
///
/// Present so a task written by one Aurora and claimed by another — a stale
/// background instance, an install mid-upgrade — is *rejected* rather than
/// misread. A dispatch that silently loses its model choice because the
/// reader expected a different shape is worse than one that refuses to run.
pub const TASK_FORMAT_VERSION: u32 = 1;

/// Suffix for a request waiting to be claimed.
pub const TASK_SUFFIX: &str = ".task.json";
/// Suffix a request is renamed to once an Aurora instance owns it.
pub const CLAIMED_SUFFIX: &str = ".claimed.json";
/// Suffix for the append-only transcript.
pub const TRANSCRIPT_SUFFIX: &str = ".jsonl";

/// What execution mode the dispatched turn should run under.
///
/// Mirrors [`crate::agent_runtime::ipc::AgentExecutionMode`] rather than
/// re-using it, for the contract reason in the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    /// Full tool access.
    #[default]
    Agent,
    /// Read-only tools plus `plan_write`.
    Plan,
}

/// Where a dispatch came from.
///
/// Diagnostic only — nothing routes on it. It exists because the transcripts
/// accumulate in one directory across every terminal on the machine, and
/// "which shell did this come from, and is that process still alive" is the
/// first question when one of them looks wrong.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskOrigin {
    /// PID of the `aurora` process that wrote the request.
    pub pid: u32,
    /// Working directory the command was typed in. Not the workspace: the two
    /// differ whenever `--path` is passed explicitly, and knowing where the
    /// user actually stood is what makes a wrong `--path` obvious.
    pub cwd: Option<String>,
    /// Hostname, for a task directory synced or inspected across machines.
    pub host: Option<String>,
}

impl TaskOrigin {
    /// Capture the current process's origin.
    pub fn capture() -> Self {
        Self {
            pid: std::process::id(),
            cwd: std::env::current_dir()
                .ok()
                .map(|dir| dir.to_string_lossy().into_owned()),
            host: hostname::get()
                .ok()
                .map(|name| name.to_string_lossy().into_owned()),
        }
    }
}

/// A unit of work handed from a terminal to a running Aurora.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    /// See [`TASK_FORMAT_VERSION`].
    pub version: u32,
    /// Task id — also the stem of both filenames. See [`new_task_id`].
    pub id: String,
    /// RFC3339 instant the request was written.
    pub created_at: String,
    /// The user's prompt, verbatim. Rendered in the Agent Window as a real
    /// user message, so it is stored exactly as typed with no wrapping.
    pub prompt: String,

    /// Workspace root the turn is scoped to.
    ///
    /// Always resolved to an absolute path by the CLI before writing, never
    /// left as the `.` the user typed: the claiming process has its own
    /// working directory, and a relative path would resolve against the wrong
    /// one — silently running the task in whatever folder Aurora was started
    /// from.
    pub workspace_path: String,

    /// Thread to continue, when the user passed `--continue <id>`.
    ///
    /// `None` opens a new chat scoped to [`Self::workspace_path`]. A thread id
    /// that no longer exists is resolved *by the CLI before dispatch* — it
    /// offers the recent threads to pick from — so by the time a request
    /// reaches this file the id is one that was known to exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,

    /// Provider to run on, as an `llm_providers.id`.
    ///
    /// `None` means "whatever the window has selected", which is the common
    /// case and the reason this is optional rather than required.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,

    /// Model key under [`Self::provider_id`].
    ///
    /// Paired with the provider rather than standing alone because a bare
    /// model name does not identify a model here: `glm-5.2` is served by
    /// several providers at different prices, context windows, and — as
    /// `.knowledge` records for the relabelling gateways — occasionally
    /// different models entirely. The CLI resolves the pair before writing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Execution mode for the turn.
    #[serde(default)]
    pub mode: TaskMode,

    /// A second path the transcript is mirrored to, from `--out`.
    ///
    /// The canonical transcript always lives beside the request in the task
    /// directory; this is a convenience copy at a path the caller chose, so a
    /// script can name its own output file without knowing Aurora's layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_path: Option<String>,

    /// Who dispatched this. Diagnostic only.
    pub origin: TaskOrigin,
}

impl TaskRequest {
    /// Filename of the pending request.
    pub fn file_name(&self) -> String {
        format!("{}{TASK_SUFFIX}", self.id)
    }

    /// Filename of the transcript.
    pub fn transcript_name(&self) -> String {
        format!("{}{TRANSCRIPT_SUFFIX}", self.id)
    }

    /// The model as a `providerId:modelKey` pin, when both halves are known.
    ///
    /// This is the form the rest of Aurora stores a conversation's model in
    /// (`SessionMetadata.model`), so producing it here keeps the CLI from
    /// inventing a second spelling of the same fact.
    pub fn model_pin(&self) -> Option<String> {
        match (&self.provider_id, &self.model) {
            (Some(provider), Some(model)) => Some(format!("{provider}:{model}")),
            _ => None,
        }
    }
}

/// One line of a transcript.
///
/// Untagged-adjacent by design: every variant serialises to an object with a
/// `"type"` field and its own flat payload, so a reader can switch on `type`
/// without knowing this enum. Unknown future variants are skippable by any
/// consumer that ignores types it does not recognise — which is why new
/// variants may be *added* freely but existing ones never change shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    /// Always the first line. Says what was actually run — after the CLI
    /// resolved the model, the thread, and the workspace — so the transcript
    /// is self-describing without the request file beside it.
    Dispatch {
        task_id: String,
        thread_id: String,
        workspace_path: String,
        /// `providerId:modelKey`, or `None` when the window's own selection
        /// was used and the CLI never named one.
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        at: String,
    },

    /// A chunk of visible assistant text.
    ///
    /// Deltas, not whole messages: a follower is watching this live, and
    /// buffering a paragraph to emit it whole would replace streaming with a
    /// series of pauses. Consumers that want whole messages concatenate until
    /// the next non-`Text` event.
    Text { text: String },

    /// A chunk of reasoning output, when the model exposes it.
    ///
    /// The provider's opaque `signature` is deliberately dropped on the way
    /// in: it is replay plumbing for the next request, it is worthless to a
    /// reader, and it is the kind of token that should not be written to a
    /// file a user might paste.
    Thinking { text: String },

    /// The model asked to run a tool. One line per call, after its arguments
    /// have finished streaming and parsed.
    Tool {
        tool_use_id: String,
        name: String,
        input: serde_json::Value,
    },

    /// A tool finished.
    ToolResult {
        tool_use_id: String,
        name: String,
        /// False when the tool reported failure. Named for the success case
        /// because that is what a reader branches on.
        ok: bool,
        /// The tool's output, truncated to [`MAX_EVENT_TEXT`].
        content: String,
        /// Set when [`Self::ToolResult::content`] was cut, giving the full
        /// length so a reader knows what it is missing.
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated_from: Option<usize>,
    },

    /// Token accounting, as the provider reported it.
    Usage {
        input_tokens: u32,
        output_tokens: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_read_tokens: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },

    /// Something worth telling the user that is not a failure — a retry after
    /// a dropped stream, a compaction, a queued message landing.
    Notice { message: String },

    /// Always the last line. A transcript without one was interrupted.
    Result {
        subtype: ResultKind,
        /// The assistant's final text, for the common case of a caller that
        /// wants the answer and not the working.
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        /// Populated when `subtype` is not `success`.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        duration_ms: u64,
        num_turns: u32,
    },
}

/// How a dispatch ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultKind {
    /// The turn completed.
    Success,
    /// The turn failed. `error` carries the rendered reason.
    Error,
    /// Stopped by the user — `aurora cancel`, or Stop in the Agent Window.
    Cancelled,
}

/// Cap on any single text payload written to a transcript.
///
/// A tool that reads a 4 MB file would otherwise put 4 MB on one line, and the
/// transcript's whole value is that it can be tailed and parsed cheaply while
/// a turn is still running. 16 KiB holds any realistic diff or command output
/// while keeping a line something a reader can hold in memory without care.
///
/// The full output is never lost: it is in the thread's own session record,
/// which is what the Agent Window renders. This cap applies only to the
/// terminal-facing copy.
pub const MAX_EVENT_TEXT: usize = 16 * 1024;

/// Truncate on a character boundary, reporting the original length when cut.
///
/// Byte-slicing a UTF-8 string at a fixed offset panics mid-codepoint, and
/// tool output is exactly where multi-byte text shows up — a path with an
/// accent, a source file in any non-Latin script.
pub fn cap_text(text: &str) -> (String, Option<usize>) {
    if text.len() <= MAX_EVENT_TEXT {
        return (text.to_string(), None);
    }
    let mut end = MAX_EVENT_TEXT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), Some(text.len()))
}

/// Generate a task id: a sortable UTC timestamp plus a short random tail.
///
/// Sortable because these accumulate in one directory and `ls` should show
/// them in the order they were dispatched. Random tail because two commands
/// fired in the same second must not collide — the timestamp alone is not an
/// identity, and a collision would have one dispatch overwrite another's
/// request file.
pub fn new_task_id() -> String {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    // First 6 hex chars of a v4 UUID: 24 bits of entropy, which is ample
    // against same-second collisions and keeps the id short enough to retype.
    let tail: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    format!("{stamp}-{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TaskRequest {
        TaskRequest {
            version: TASK_FORMAT_VERSION,
            id: "20260901T142233-7f3a91".to_string(),
            created_at: "2026-09-01T14:22:33Z".to_string(),
            prompt: "refactor the timeline service".to_string(),
            workspace_path: r"E:\PayNu-Social\paynu_app".to_string(),
            thread_id: None,
            provider_id: Some("fireworks".to_string()),
            model: Some("glm-5.2".to_string()),
            mode: TaskMode::Agent,
            out_path: None,
            origin: TaskOrigin {
                pid: 4242,
                cwd: None,
                host: None,
            },
        }
    }

    #[test]
    fn task_ids_are_sortable_and_unique() {
        let a = new_task_id();
        let b = new_task_id();
        assert_ne!(a, b, "two ids in the same second collided");
        // Both start with the same date, so lexical order is chronological.
        assert_eq!(a[..8], b[..8]);
        assert!(a.contains('-'));
    }

    #[test]
    fn file_names_share_the_id_stem() {
        let request = request();
        assert_eq!(request.file_name(), "20260901T142233-7f3a91.task.json");
        assert_eq!(request.transcript_name(), "20260901T142233-7f3a91.jsonl");
    }

    #[test]
    fn model_pin_needs_both_halves() {
        let mut request = request();
        assert_eq!(request.model_pin().as_deref(), Some("fireworks:glm-5.2"));
        // A model with no provider is exactly the ambiguity this CLI exists to
        // remove, so it must not produce a pin.
        request.provider_id = None;
        assert_eq!(request.model_pin(), None);
        request.model = None;
        assert_eq!(request.model_pin(), None);
    }

    #[test]
    fn request_round_trips_as_camel_case() {
        let json = serde_json::to_string(&request()).expect("serialise");
        assert!(json.contains("\"workspacePath\""));
        assert!(json.contains("\"createdAt\""));
        // Absent options stay off the wire rather than appearing as null.
        assert!(!json.contains("threadId"));
        let back: TaskRequest = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(back.prompt, "refactor the timeline service");
        assert_eq!(back.mode, TaskMode::Agent);
    }

    #[test]
    fn events_carry_a_type_discriminator() {
        let line = serde_json::to_string(&TaskEvent::Text {
            text: "hello".to_string(),
        })
        .expect("serialise");
        assert_eq!(line, r#"{"type":"text","text":"hello"}"#);
    }

    #[test]
    fn result_line_matches_the_reference_shape() {
        let line = serde_json::to_string(&TaskEvent::Result {
            subtype: ResultKind::Success,
            result: Some("done".to_string()),
            error: None,
            duration_ms: 1200,
            num_turns: 3,
        })
        .expect("serialise");
        assert!(line.contains(r#""type":"result""#));
        assert!(line.contains(r#""subtype":"success""#));
        // `error` is absent, not null, so a reader can test for presence.
        assert!(!line.contains("error"));
    }

    #[test]
    fn transcript_lines_never_contain_a_newline() {
        // The format is one object per line; an embedded raw newline would
        // split a record in two and desynchronise every reader after it.
        let line = serde_json::to_string(&TaskEvent::Text {
            text: "first\nsecond".to_string(),
        })
        .expect("serialise");
        assert!(!line.contains('\n'));
        assert!(line.contains("\\n"));
    }

    #[test]
    fn cap_text_leaves_short_text_alone() {
        let (text, truncated) = cap_text("short");
        assert_eq!(text, "short");
        assert_eq!(truncated, None);
    }

    #[test]
    fn cap_text_reports_what_it_cut() {
        let long = "x".repeat(MAX_EVENT_TEXT + 500);
        let (text, truncated) = cap_text(&long);
        assert_eq!(text.len(), MAX_EVENT_TEXT);
        assert_eq!(truncated, Some(MAX_EVENT_TEXT + 500));
    }

    #[test]
    fn cap_text_never_splits_a_codepoint() {
        // A 3-byte character straddling the cap is the case that panics a
        // naive `&text[..MAX]`.
        let long = "あ".repeat(MAX_EVENT_TEXT);
        let (text, truncated) = cap_text(&long);
        assert!(truncated.is_some());
        assert!(text.len() <= MAX_EVENT_TEXT);
        // The proof it cut cleanly: it is still valid UTF-8 we can re-read.
        assert!(text.chars().all(|c| c == 'あ'));
    }
}
