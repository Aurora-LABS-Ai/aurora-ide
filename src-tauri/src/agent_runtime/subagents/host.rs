//! The seam between the sub-agent tools and whatever runs a sub-agent.
//!
//! The tools (`crate::tools::subagents`) are built per turn and know the
//! parent's situation: its thread, its turn, its cancel token. They do not
//! know how to build an API client, pick a store, or drive the turn loop —
//! that is `commands::agent_v2`'s job, and it implements [`SubagentHost`].
//! Keeping the tools on this side of a trait is what lets them be tested with
//! a scripted host and what keeps `tools/` from depending on the command
//! layer.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::record::TaskSnapshot;
use crate::agent_runtime::ipc::AgentChatRequest;
use crate::agent_runtime::session_store::SessionStore;
use crate::agent_runtime::types::TokenUsage;

/// What one run cost, in the terms the parent is told.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tool_calls: u64,
    /// Model round trips.
    pub iterations: u64,
    pub duration_ms: u64,
}

impl SubagentUsage {
    pub fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.tool_calls = self.tool_calls.saturating_add(other.tool_calls);
        self.iterations = self.iterations.saturating_add(other.iterations);
        self.duration_ms = self.duration_ms.saturating_add(other.duration_ms);
    }

    #[must_use]
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    #[must_use]
    pub fn from_turn(usage: &TokenUsage, iterations: u32, tool_calls: u64, duration_ms: u64) -> Self {
        Self {
            input_tokens: u64::from(usage.input_tokens),
            output_tokens: u64::from(usage.output_tokens),
            tool_calls,
            iterations: u64::from(iterations),
            duration_ms,
        }
    }
}

/// The parent's side of a spawn: everything a child inherits or hangs off.
///
/// Built once per parent turn by the turn driver and shared by every
/// sub-agent tool in that turn's roster.
pub struct ParentTurn {
    pub thread_id: String,
    pub turn_id: String,
    /// The request the parent is running. The child's provider snapshot,
    /// workspace, access level, context window and compaction settings are
    /// copied from it — copied, never shared.
    pub request: Arc<AgentChatRequest>,
    /// The store that owns the parent's conversation. Children live in a
    /// folder inside the parent's thread directory.
    pub store: Arc<SessionStore>,
    /// The parent turn's token. A synchronous child's token is a child of
    /// this one, so stopping the parent stops it.
    pub cancel: CancellationToken,
}

/// What the parent asked for.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    /// 3–6 words for the Agents list and for notifications.
    pub description: String,
    /// The task. Becomes the child's first and only user message.
    pub prompt: String,
    /// Which definition. `None` is the general-purpose one.
    pub agent_type: Option<String>,
    /// `providerId:modelKey` to run on, overriding the definition and the
    /// settings default.
    pub model: Option<String>,
    pub background: bool,
    /// A handle the parent can address later, instead of the id.
    pub name: Option<String>,
}

/// What the parent gets back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SpawnOutcome {
    /// Synchronous: the child ran to the end inside the tool call.
    Finished {
        agent_id: String,
        /// `completed`, `failed`, or `killed`.
        state: String,
        /// The child's final message, or its best partial answer.
        result: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        usage: SubagentUsage,
        /// The child's transcript on disk, readable with `file_read`.
        output_file: String,
    },
    /// Background: the child is running; the parent will be told.
    Launched {
        agent_id: String,
        output_file: String,
    },
}

/// Why a sub-agent operation could not be done.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SubagentError {
    /// The parent asked for something that does not exist or cannot run.
    #[error("{0}")]
    Invalid(String),
    /// A model pin that no configured provider serves.
    #[error("{0}")]
    UnknownModel(String),
    /// The child could not be started — store, client, or session failure.
    #[error("could not start the sub-agent: {0}")]
    Start(String),
    /// Nothing is known about the agent named.
    #[error("no sub-agent named {0:?} is known to this conversation")]
    NotFound(String),
    #[error("sub-agents are not available in this turn")]
    Unavailable,
}

/// One model the parent could pick for a child.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// `providerId:modelKey` — what to pass as `model`.
    pub pin: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_output_per_mtok: Option<f64>,
    /// The model the parent itself is running on.
    pub current: bool,
}

/// A model pin resolved to something a child can be started on.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub provider_id: String,
    pub model_key: String,
    pub config: crate::api::ProviderConfigSnapshot,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
}

/// Reads the user's configured providers and models, so a child can run on a
/// model the parent is not using.
///
/// A trait because the only real source is the app's SQLite database, which
/// the runtime must not open itself; production hands in a database-backed
/// one, tests a fixed list.
pub trait ProviderLookup: Send + Sync + 'static {
    /// Every enabled model on every enabled provider.
    fn models(&self) -> Result<Vec<ModelChoice>, String>;

    /// Build the provider snapshot for `providerId:modelKey`.
    fn resolve(&self, pin: &str) -> Result<ResolvedModel, String>;
}

/// What `send_message` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum SendOutcome {
    /// The agent is running; the message waits for its next safe point, or,
    /// when `taken_now`, goes straight to a `message_parent` call that was
    /// holding for this answer.
    Queued {
        agent_id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        taken_now: bool,
    },
    /// The agent had finished (or was forgotten); it is running again with
    /// the message as its new task, in the background.
    Resumed {
        agent_id: String,
        output_file: String,
        /// Set when the agent's original definition no longer exists and the
        /// general-purpose one was used instead.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

/// How a child's mid-run message reached the parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDelivery {
    /// The parent has a turn running; the message lands on its next tool
    /// message.
    QueuedIntoTurn,
    /// The parent was idle; the window starts a turn with the message.
    WokeParent,
}

/// How far a child got, in its own words (`submit_report`'s `outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    /// The task is done as asked.
    Done,
    /// Some of it is done; the report says what is left.
    Partial,
    /// It could not be done; the report says what stopped it.
    Blocked,
}

impl ReportOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Partial => "partial",
            Self::Blocked => "blocked",
        }
    }
}

/// The report a child hands in with `submit_report`.
///
/// A report the child chose to submit, not whatever it happened to say
/// last: Claude Code's `StructuredOutput` pattern, where the agent must call
/// one tool at the end and the runtime holds it to that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedReport {
    pub outcome: ReportOutcome,
    /// One to three sentences: the answer, or what happened.
    pub summary: String,
    /// The full report.
    pub report: String,
    /// Files it created, changed or deleted, workspace-relative.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<String>,
}

impl SubmittedReport {
    /// The report as one text, for the sidecar and the window.
    #[must_use]
    pub fn as_text(&self) -> String {
        format!("{}\n\n{}", self.summary.trim(), self.report.trim())
    }
}

/// The child's two lines back to its parent.
///
/// A child cannot ask the user anything, so `message_parent` is its only way
/// to raise a hand before the end: a tool it needs and does not have, a
/// contradiction in the brief, a decision only the parent can make.
/// `submit_report` is how it ends. Built per child run by the host and handed
/// to the child's two tools.
#[async_trait]
pub trait ParentMessenger: Send + Sync + 'static {
    /// Deliver `text` to the parent. `waiting` says the child will hold for the
    /// answer, so the parent is told to reply now.
    fn message_parent(&self, text: &str, waiting: bool) -> Result<MessageDelivery, SubagentError>;

    /// Hold for the parent's answer to a `message_parent` call, up to
    /// `timeout`. `None` when nothing came, or `cancel` fired. An answer taken
    /// here is consumed: it does not arrive a second time as a message.
    async fn wait_for_reply(
        &self,
        _timeout: std::time::Duration,
        _cancel: &CancellationToken,
    ) -> Option<String> {
        None
    }

    /// Hold `report` as this run's report. Delivered when the run ends, not
    /// now: the child may still be working, and a second submission replaces
    /// the first. Returns whether an earlier submission was replaced.
    fn submit_report(&self, report: SubmittedReport) -> Result<bool, SubagentError>;
}

/// What a child has been doing since the parent last checked: the shape of
/// its work, not its results. Tool calls by name with what they were on, its
/// thoughts and replies trimmed, the messages that reached it, in order.
/// Enough for the parent to know whether to wait, redirect, or stop it; never
/// enough to drag the child's transcript into the parent's context. Built
/// from the child's live stream (`activity::ActivityLog`), never by reading
/// its session, which the running turn holds locked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Model round trips so far, this run and earlier ones in this process.
    pub steps: usize,
    /// Tool calls so far.
    pub tool_calls: usize,
    /// Everything since the previous check, oldest first.
    pub timeline: Vec<String>,
    /// Earlier unseen lines left out of `timeline`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub omitted: usize,
    /// The thought or reply being produced right now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_progress: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// What `stop_agent` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum StopOutcome {
    /// It was running and has been told to stop.
    Stopped { agent_id: String },
    /// It had already ended; nothing to stop.
    NotRunning { agent_id: String, status: String },
}

/// Everything the tools need from the layer that runs agents.
#[async_trait]
pub trait SubagentHost: Send + Sync + 'static {
    /// What a child has done since the parent last checked, and mark it seen.
    /// `None` when this process has no live record of it.
    async fn activity(&self, _parent: &ParentTurn, _task_id: &str) -> Option<Activity> {
        None
    }

    /// Stop a running child by name or id. Its transcript stays; it can be
    /// given more work later with `send_message`.
    async fn stop(&self, _parent: &ParentTurn, to: &str) -> Result<StopOutcome, SubagentError> {
        Err(SubagentError::NotFound(to.to_string()))
    }

    /// Start a child. Synchronous spawns return when the child is done;
    /// background spawns return as soon as it is running.
    async fn spawn(
        &self,
        parent: &ParentTurn,
        request: SpawnRequest,
    ) -> Result<SpawnOutcome, SubagentError>;

    /// Send a follow-up to an agent by name or id. Queued if it is running,
    /// otherwise it is resumed with the message as its next task.
    async fn send_message(
        &self,
        parent: &ParentTurn,
        to: &str,
        message: &str,
    ) -> Result<SendOutcome, SubagentError>;

    /// One agent's state, waiting up to `wait` for it to finish when asked.
    /// Only a look: a finished agent's report still reaches the parent as a
    /// message, whoever looked first.
    async fn output(
        &self,
        parent: &ParentTurn,
        task_id: &str,
        wait: Option<std::time::Duration>,
    ) -> Result<TaskSnapshot, SubagentError>;

    /// Every agent this parent has, live state first, newest first.
    fn list(&self, parent_thread_id: &str) -> Vec<TaskSnapshot>;

    /// The models a child could run on, from the user's configured
    /// providers.
    fn models(&self, parent: &ParentTurn) -> Result<Vec<ModelChoice>, SubagentError>;

    /// One line per available definition, for the tool description.
    fn describe_definitions(&self) -> String;
}
