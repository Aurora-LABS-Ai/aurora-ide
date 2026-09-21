//! `run_member` — one team member as a **real headless agent**.
//!
//! This replaces the old `build_runner` mini-loop. A member is no longer a
//! capped 16-iteration tool loop with nudge hacks; it is a full
//! [`ConversationRuntime`] session — the same engine that drives Aurora's
//! main chat — with:
//!
//! - the real registry tools (files, search, tree, websearch) plus a
//!   **shell** (validated by `agent_safety`) so a member can actually run
//!   the tests/build it was told to run before reporting;
//! - a **scope gate** decorating every mutating file tool: writes outside
//!   the member's owned paths are refused with the owner's name, and every
//!   accepted change is recorded as the authoritative changed-files list;
//! - **real teammates**: `ask_member` routes a question into the addressed
//!   member's live conversation and waits for its actual `reply`;
//!   `ask_lead` parks on the lead inbox until the real chat Lead answers
//!   (the member shows `waiting_input` meanwhile) — no role-played
//!   stand-ins anywhere;
//! - a **mailbox**: messages from the Lead and peers are injected into the
//!   member's running turn at the next tool-result boundary via the
//!   session's queued-message slot;
//! - a **report**: the member ends by calling `report` (done | blocked)
//!   with its own summary. Changing zero files is legal — an
//!   investigate-only assignment reports findings, not diffs. A member
//!   that never reports is `failed` by the engine, honestly.
//!
//! Streaming rides the existing `team_stream` contract (start/delta/end
//! frames per message) and the per-agent transcript file
//! (`agents/<id>/session.jsonl`) is mirrored **live** from the event
//! stream, then finalized from the authoritative session after each turn.

#![allow(dead_code)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_runtime::api_client::{ReasoningConfig, ToolSchema};
use crate::agent_runtime::conversation::{ConversationRuntime, RuntimeConfig};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::ipc::AgentEventEnvelope;
use crate::agent_runtime::session::Session;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};
use crate::api::{build_api_client, ProviderConfigSnapshot};
use crate::tools::shell_editor_todo::NoopIdeEventSink;

use super::bus::TeamBus;
use super::mailbox::{CommsError, TeamComms, LEAD_REPLY_TIMEOUT, PEER_REPLY_TIMEOUT};
use super::orchestrator::{TeamSession, LEAD_AGENT_ID};
use super::types::{
    AgentRecord, AgentStatus, ChannelEvent, ChannelEventKind, MemberReport, ReportStatus,
    TeamStreamDelta,
};
use super::workspace::{now_rfc3339, ProjectWorkspace};

/// Cap on assistant↔tool round trips inside ONE `run_turn` call. Generous —
/// the runtime's own loop discipline replaces the old idle-nudge machinery —
/// but bounded, because a background member burning tokens forever with no
/// user watching is worse than a turn that wraps early and reports.
const MEMBER_MAX_ITERATIONS: u32 = 48;

/// How many `run_turn` calls a member gets (initial + mailbox follow-ups +
/// one wrap-up ask). A member that hasn't reported by then is failed.
const MEMBER_MAX_TURNS: usize = 8;

/// Conservative context-window assumption for compaction/trim sizing. The
/// provider snapshot doesn't carry the real window; every model the team
/// realistically runs on has at least this much, and compacting a little
/// early is harmless while overflowing a smaller model's window kills the
/// member mid-build.
const MEMBER_CONTEXT_WINDOW: u32 = 100_000;

/// Compaction trigger, as a fraction of [`MEMBER_CONTEXT_WINDOW`].
const MEMBER_COMPACTION_THRESHOLD: f32 = 0.80;

/// Fallback output budget when the provider config doesn't set one.
const FALLBACK_MAX_OUTPUT_TOKENS: u32 = 8192;

/// Mutating file tools whose single `path` argument must pass the scope gate.
const PATH_GUARDED_TOOLS: &[&str] = &["file_write", "file_edit", "delete_path", "folder_create"];

/// Resolve the output-token budget from the provider's configured
/// `default_max_tokens`, falling back only when unset.
pub(crate) fn resolved_max_tokens(provider: &ProviderConfigSnapshot) -> u32 {
    provider
        .default_max_tokens
        .filter(|&n| n > 0)
        .unwrap_or(FALLBACK_MAX_OUTPUT_TOKENS)
}

// ─── shared per-member context ────────────────────────────────────────────

/// State shared between one member's team tools, its scope gate, and its
/// actor loop. Cheap to share behind `Arc`; brain mutations go through
/// `comms.lock_brain()` because members run on separate tokio tasks.
pub(crate) struct MemberCtx {
    pub bus: Arc<TeamBus>,
    pub comms: Arc<TeamComms>,
    /// This member's own control surface over the brain (reads are
    /// lock-free; mutations are wrapped in the brain lock by callers).
    pub session: TeamSession,
    pub agent_id: String,
    pub role: String,
    pub run_id: Option<String>,
    /// (id, role) of everyone on the roster, Lead excluded.
    pub roster: Vec<(String, String)>,
    /// Repo-relative paths the scope gate accepted as real changes.
    pub changed: Mutex<Vec<String>>,
    /// The member's filed report, set by the `report` tool.
    pub report: Mutex<Option<(ReportStatus, String)>>,
}

impl MemberCtx {
    fn post(&self, kind: ChannelEventKind, body: String, meta: Value) {
        let _ = self.bus.post(
            self.session.workspace(),
            ChannelEvent {
                id: Uuid::new_v4().to_string(),
                ts: now_rfc3339(),
                author: self.agent_id.clone(),
                kind,
                body,
                meta: Some(meta),
            },
        );
    }

    fn record_change(&self, label: String) {
        let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
        if !changed.iter().any(|c| c == &label) {
            changed.push(label);
            self.comms.bump_changed(&self.agent_id);
        }
    }

    fn changed_snapshot(&self) -> Vec<String> {
        self.changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn filed_report(&self) -> Option<(ReportStatus, String)> {
        self.report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Resolve a teammate reference (`agent id` or role name, case-insensitive)
    /// to its agent id.
    fn resolve_member(&self, who: &str) -> Option<String> {
        let want = who.trim().trim_start_matches('@').to_lowercase();
        self.roster
            .iter()
            .find(|(id, role)| id.to_lowercase() == want || role.to_lowercase() == want)
            .map(|(id, _)| id.clone())
    }

    async fn set_status(&self, status: AgentStatus) {
        self.comms
            .set_member_state(&self.agent_id, &self.role, status);
        let _guard = self.comms.lock_brain().await;
        let _ = self.session.set_agent_status(&self.agent_id, status);
    }
}

// ─── the scope gate ───────────────────────────────────────────────────────

/// Decorator that runs the scope write-guard before a mutating file tool
/// and records accepted changes. This is enforcement, not advice: the inner
/// tool never runs on a refused path, and the refusal names the owner so
/// the model's next move (ask the owner, or ask the Lead for access) is
/// obvious.
struct ScopeGatedTool {
    inner: Arc<dyn ToolExecutor>,
    ctx: Arc<MemberCtx>,
}

impl ScopeGatedTool {
    fn new(inner: Arc<dyn ToolExecutor>, ctx: Arc<MemberCtx>) -> Self {
        Self { inner, ctx }
    }

    fn check(&self, rel: &str) -> Result<String, ToolError> {
        let decision = self
            .ctx
            .session
            .check_write(&self.ctx.agent_id, rel)
            .map_err(|e| ToolError::Execution(format!("scope check failed: {e}")))?;
        if decision.allowed {
            Ok(decision.path)
        } else {
            Err(ToolError::PolicyViolation(format!(
                "write refused: {}. Coordinate with the owner via ask_member, or ask_lead for access.",
                decision.reason
            )))
        }
    }
}

#[async_trait]
impl ToolExecutor for ScopeGatedTool {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> ToolSchema {
        self.inner.schema()
    }

    fn concurrency_safe(&self) -> bool {
        false
    }

    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        self.inner.timeout_policy()
    }

    async fn execute(&self, input: Value, tctx: &ToolContext) -> Result<String, ToolError> {
        let name = self.inner.name();
        let mut labels: Vec<String> = Vec::new();

        if name == "move_path" {
            // A move mutates BOTH ends — source vanishes, destination appears.
            for key in ["old_path", "new_path"] {
                let Some(rel) = input.get(key).and_then(Value::as_str) else {
                    return Err(ToolError::InvalidInput(format!(
                        "move_path requires '{key}'"
                    )));
                };
                labels.push(self.check(rel)?);
            }
        } else {
            let Some(rel) = input.get("path").and_then(Value::as_str) else {
                return Err(ToolError::InvalidInput(format!("{name} requires 'path'")));
            };
            let normalized = self.check(rel)?;
            labels.push(if name == "delete_path" {
                format!("{normalized} (deleted)")
            } else {
                normalized
            });
        }

        let result = self.inner.execute(input, tctx).await?;
        for label in labels {
            self.ctx.record_change(label);
        }
        Ok(result)
    }
}

// ─── team tools ───────────────────────────────────────────────────────────

macro_rules! member_tool {
    ($ty:ident) => {
        struct $ty(Arc<MemberCtx>);
    };
}

member_tool!(SendMessageTool);
member_tool!(AskMemberTool);
member_tool!(AskLeadTool);
member_tool!(ReplyTool);
member_tool!(PublishContractTool);
member_tool!(ReportTool);

#[async_trait]
impl ToolExecutor for SendMessageTool {
    fn name(&self) -> &str {
        "send_message"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "send_message".into(),
            description: "Post a message to the team group chat. @mention a teammate (by role or \
                          id) to deliver it into their running conversation. This does not wait \
                          for an answer — use ask_member when you need one."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The message. Mention teammates as @their-role." }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let text = require_str(&input, "text")?;
        ctx.post(
            ChannelEventKind::Message,
            text.to_string(),
            json!({ "phase": "working", "chat": true }),
        );

        // Deliver to every @mentioned teammate's live mailbox.
        let mut delivered = Vec::new();
        let mut unreachable = Vec::new();
        for (id, role) in &ctx.roster {
            if *id == ctx.agent_id {
                continue;
            }
            let lower = text.to_lowercase();
            let hit = lower.contains(&format!("@{}", id.to_lowercase()))
                || lower.contains(&format!("@{}", role.to_lowercase()));
            if hit {
                match ctx.comms.send_to(id, &ctx.agent_id, text) {
                    Ok(()) => delivered.push(role.clone()),
                    Err(_) => unreachable.push(role.clone()),
                }
            }
        }

        let mut out = String::from("Posted to the team chat.");
        if !delivered.is_empty() {
            out.push_str(&format!(
                " Delivered directly to: {}.",
                delivered.join(", ")
            ));
        }
        if !unreachable.is_empty() {
            out.push_str(&format!(
                " Not delivered (already finished): {} — they will not see it.",
                unreachable.join(", ")
            ));
        }
        if text.to_lowercase().contains("@lead") {
            out.push_str(" Note: the Lead does not read the chat live — use ask_lead to actually reach them.");
        }
        Ok(out)
    }
}

#[async_trait]
impl ToolExecutor for AskMemberTool {
    fn name(&self) -> &str {
        "ask_member"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "ask_member".into(),
            description: "Ask a specific teammate a question and wait for their real answer. The \
                          question is delivered into their running conversation; you get back \
                          exactly what they reply (or an honest timeout if they don't answer)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "The teammate's role or agent id." },
                    "question": { "type": "string" }
                },
                "required": ["to", "question"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let to_raw = require_str(&input, "to")?;
        let question = require_str(&input, "question")?;

        if to_raw
            .trim()
            .trim_start_matches('@')
            .eq_ignore_ascii_case(LEAD_AGENT_ID)
        {
            return Err(ToolError::InvalidInput(
                "use ask_lead to reach the Lead — ask_member is for teammates".into(),
            ));
        }
        let Some(to) = ctx.resolve_member(to_raw) else {
            let roster: Vec<&str> = ctx.roster.iter().map(|(_, r)| r.as_str()).collect();
            return Err(ToolError::InvalidInput(format!(
                "no teammate '{to_raw}'. Team: {}",
                roster.join(", ")
            )));
        };

        // The ask is visible in the group chat before it's delivered.
        ctx.post(
            ChannelEventKind::BoundaryQuestion,
            format!("@{to} {question}"),
            json!({ "phase": "working", "to": to }),
        );

        match ctx
            .comms
            .ask(&ctx.agent_id, &to, question, PEER_REPLY_TIMEOUT)
            .await
        {
            Ok(answer) => Ok(format!("{to} replied: {answer}")),
            Err(CommsError::Timeout(who)) => Ok(format!(
                "{who} — no answer yet. Proceed on your best judgment, state the assumption you \
                 made in the team chat, and keep building. Their answer (if it comes) will appear \
                 in the chat."
            )),
            Err(CommsError::Unreachable(who)) => Ok(format!(
                "{who} has already finished their work and can't answer. Check their files and \
                 published contracts directly, or ask_lead."
            )),
        }
    }
}

#[async_trait]
impl ToolExecutor for AskLeadTool {
    fn name(&self) -> &str {
        "ask_lead"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "ask_lead".into(),
            description: "Ask the Lead a question — direction, a blocker, or write access to \
                          paths you don't own. This reaches the actual Lead; you wait until they \
                          answer (or an honest timeout tells you to proceed on your own judgment)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "Your question. For access requests, name the exact paths." }
                },
                "required": ["question"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let question = require_str(&input, "question")?;

        ctx.post(
            ChannelEventKind::BoundaryQuestion,
            format!("@lead {question}"),
            json!({ "phase": "working", "to": LEAD_AGENT_ID }),
        );

        // The member is genuinely waiting on a person now — show it.
        ctx.set_status(AgentStatus::WaitingInput).await;
        let outcome = ctx
            .comms
            .ask_lead(
                &ctx.agent_id,
                &ctx.role,
                ctx.run_id.clone(),
                question,
                LEAD_REPLY_TIMEOUT,
            )
            .await;
        ctx.set_status(AgentStatus::Working).await;

        match outcome {
            Ok(answer) => Ok(format!("The Lead replied: {answer}")),
            Err(_) => Ok(
                "The Lead hasn't answered (they may be away). Continue with what you can do \
                 inside your own scope; if this question truly blocks your assignment, call \
                 report with status \"blocked\" and say exactly what you're waiting on."
                    .into(),
            ),
        }
    }
}

#[async_trait]
impl ToolExecutor for ReplyTool {
    fn name(&self) -> &str {
        "reply"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "reply".into(),
            description: "Answer a teammate's question. Use the question_id from the incoming \
                          question message; your text is delivered straight back to the waiting \
                          teammate."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "question_id": { "type": "string" },
                    "text": { "type": "string", "description": "Your concrete answer." }
                },
                "required": ["question_id", "text"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let qid = require_str(&input, "question_id")?;
        let text = require_str(&input, "text")?;

        // Visible in the group chat regardless of delivery.
        ctx.post(
            ChannelEventKind::Message,
            text.to_string(),
            json!({ "phase": "working", "chat": true, "replyTo": qid }),
        );

        if ctx.comms.resolve(qid, text) {
            Ok("Reply delivered to the waiting teammate.".into())
        } else {
            Ok(
                "The asker stopped waiting (timeout) — your answer is posted in the team chat \
                where they'll see it on their next update."
                    .into(),
            )
        }
    }
}

#[async_trait]
impl ToolExecutor for PublishContractTool {
    fn name(&self) -> &str {
        "publish_contract"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "publish_contract".into(),
            description: "Publish a shared interface (types, endpoints, props, file formats) that \
                          teammates can build against without touching your files. Publish early — \
                          before the implementation is finished — so dependents aren't guessing."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Short contract name, e.g. \"widget-props\"." },
                    "body": { "type": "string", "description": "The exact interface, as code or precise prose." }
                },
                "required": ["name", "body"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let name = require_str(&input, "name")?;
        let body = require_str(&input, "body")?;
        let _guard = ctx.comms.lock_brain().await;
        ctx.session
            .publish_contract(&ctx.bus, &ctx.agent_id, name, body)
            .map_err(|e| ToolError::Execution(format!("could not publish: {e}")))?;
        Ok(format!(
            "Published contract '{name}'. Teammates see it in their team context."
        ))
    }
}

#[async_trait]
impl ToolExecutor for ReportTool {
    fn name(&self) -> &str {
        "report"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "report".into(),
            description: "File your final report to the Lead and end your work. status \"done\" \
                          when your assignment is complete (verified where possible), \"blocked\" \
                          when you cannot complete it — then say exactly what blocks you. A task \
                          that changes no files (investigation, review) is still \"done\" when \
                          the findings are in your summary."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["done", "blocked"] },
                    "summary": { "type": "string", "description": "What you did / found, how you verified it, and anything the Lead must know." }
                },
                "required": ["status", "summary"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value, _tctx: &ToolContext) -> Result<String, ToolError> {
        let ctx = &self.0;
        let status = match require_str(&input, "status")? {
            "done" => ReportStatus::Done,
            "blocked" => ReportStatus::Blocked,
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "status must be \"done\" or \"blocked\", got \"{other}\""
                )))
            }
        };
        let summary = require_str(&input, "summary")?;
        if summary.trim().len() < 20 {
            return Err(ToolError::InvalidInput(
                "summary is too thin to hand to the Lead — say what you did, how you verified \
                 it, and what's left"
                    .into(),
            ));
        }

        *ctx.report.lock().unwrap_or_else(|e| e.into_inner()) = Some((status, summary.to_string()));

        // The report is a first-class chat message — the run's visible record.
        ctx.post(
            ChannelEventKind::Message,
            summary.to_string(),
            json!({ "phase": "working", "report": true, "reportStatus": status }),
        );
        Ok("Report filed. Your work here is finished.".into())
    }
}

fn require_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::InvalidInput(format!("'{key}' is required")))
}

// ─── registry assembly ────────────────────────────────────────────────────

/// Build one member's tool registry: the real file/search bucket (mutators
/// scope-gated), a validated shell, and the team's coordination tools.
pub(crate) fn member_registry(ctx: &Arc<MemberCtx>) -> ToolRegistry {
    use crate::tools::shell_editor_todo::shell_execute::ShellExecuteTool;

    let mut staging = ToolRegistry::new();
    // No browser rung for a team member's web search. There is one browser and
    // one search webview in the process, and members run in parallel — several
    // of them driving it at once would have each reading whichever page the
    // others had just navigated to. Members get the two HTTP back ends; the
    // Lead, which runs alone, gets the browser as well.
    crate::tools::file_workspace_search::register(&mut staging, Arc::new(NoopIdeEventSink), None);

    let guarded: HashSet<&str> = PATH_GUARDED_TOOLS.iter().copied().collect();
    let reg = ToolRegistry::new();
    for name in staging.names() {
        let Some(tool) = staging.get(&name) else {
            continue;
        };
        if guarded.contains(name.as_str()) || name == "move_path" {
            reg.register(Arc::new(ScopeGatedTool::new(tool, ctx.clone())));
        } else {
            reg.register(tool);
        }
    }

    // A member that can't run anything can't verify anything. The command is
    // still validated by agent_safety (workspace-write mode) before it runs.
    reg.register(Arc::new(ShellExecuteTool::new(Arc::new(NoopIdeEventSink))));

    reg.register(Arc::new(SendMessageTool(ctx.clone())));
    reg.register(Arc::new(AskMemberTool(ctx.clone())));
    reg.register(Arc::new(AskLeadTool(ctx.clone())));
    reg.register(Arc::new(ReplyTool(ctx.clone())));
    reg.register(Arc::new(PublishContractTool(ctx.clone())));
    reg.register(Arc::new(ReportTool(ctx.clone())));
    reg
}

// ─── prompts ──────────────────────────────────────────────────────────────

fn member_system_prompt(role: &str, owned: &[String], roster: &[(String, String)]) -> String {
    let scope = if owned.is_empty() {
        "(none assigned — you can create files on unowned ground, but not in a teammate's area)"
            .to_string()
    } else {
        owned.join(", ")
    };
    let team_lines: String = roster
        .iter()
        .map(|(id, r)| format!("- {r} (mention as @{id})"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are \"{role}\", one member of a small software team working together in one \
         repository. You work like a professional: read before you write, verify before you \
         report, and coordinate instead of guessing.\n\n\
         Your writable scope: {scope}\n\
         Reads are unrestricted anywhere in the repo. Writes outside your scope are refused by \
         the system — when that happens, coordinate with the owner (ask_member) or request \
         access (ask_lead).\n\n\
         Your team:\n{team_lines}\n\n\
         Working rules:\n\
         - Use shell_execute to verify your work (build, tests, typecheck) whenever your task \
           calls for it. Don't claim \"verified\" without having run something.\n\
         - Use file tools for edits; use the shell for running and inspecting, not for editing \
           files outside your scope.\n\
         - publish_contract early for any interface a teammate depends on.\n\
         - ask_member when you need a real answer from a teammate; ask_lead for direction, \
           blockers, or scope access. Both wait for the real person — use them when it matters, \
           not for small talk.\n\
         - Messages from teammates and the Lead can arrive mid-work; read and act on them.\n\
         - Finish by calling report (done | blocked) with a concrete summary. If your task is \
           investigation or review, changing zero files is expected — the findings ARE the \
           deliverable."
    )
}

/// Render the shared brain into the member's opening context: ownership map,
/// published contracts, recent chat. Same content the old runner injected —
/// it's what makes members build against each other instead of guessing.
fn team_context(session: &TeamSession, me: &str) -> String {
    let ws = session.workspace();
    let mut parts: Vec<String> = Vec::new();

    if let Ok(Some(scope)) = ws.read_scope_map() {
        let lines: Vec<String> = scope
            .assignments
            .iter()
            .map(|a| {
                let who = if a.agent_id == me {
                    format!("{} (you)", a.agent_id)
                } else {
                    a.agent_id.clone()
                };
                let paths = if a.owned_paths.is_empty() {
                    "(none)".to_string()
                } else {
                    a.owned_paths.join(", ")
                };
                format!("- {who}: {paths}")
            })
            .collect();
        if !lines.is_empty() {
            parts.push(format!("Ownership map:\n{}", lines.join("\n")));
        }
    }

    if let Ok(contracts) = ws.read_contracts() {
        if !contracts.is_empty() {
            let rendered: Vec<String> = contracts
                .iter()
                .map(|(_n, b)| b.trim().to_string())
                .collect();
            parts.push(format!(
                "Published contracts (build against these, don't edit the owner's files):\n{}",
                rendered.join("\n\n")
            ));
        }
    }

    if let Ok(events) = ws.read_channel(Some(20)) {
        let lines: Vec<String> = events
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    ChannelEventKind::Message
                        | ChannelEventKind::BoundaryQuestion
                        | ChannelEventKind::ContractPublished
                )
            })
            .map(|e| format!("{}: {}", e.author, e.body.trim()))
            .collect();
        if !lines.is_empty() {
            parts.push(format!("Recent team chat:\n{}", lines.join("\n")));
        }
    }

    if parts.is_empty() {
        "(no team context yet — you're first to start)".to_string()
    } else {
        parts.join("\n\n")
    }
}

fn initial_task_message(goal: &str, task: &str, session: &TeamSession, me: &str) -> String {
    format!(
        "Overall goal:\n{goal}\n\nYour assignment from the Lead:\n{task}\n\n=== TEAM CONTEXT ===\n{}\n=== END TEAM CONTEXT ===\n\nStart now.",
        team_context(session, me)
    )
}

// ─── live stream + transcript mirror ──────────────────────────────────────

/// Consumes one member's turn events: forwards token deltas as
/// `team_stream` frames (the live bubble contract the Team screen already
/// speaks) and mirrors completed messages into `agents/<id>/session.jsonl`
/// so the per-agent transcript view updates while the member works.
struct MemberEventMirror {
    bus: Arc<TeamBus>,
    ws: ProjectWorkspace,
    project_id: String,
    agent_id: String,
    run_id: Option<String>,
    seq: AtomicU64,
    /// Serialized `ConversationMessage` lines written so far.
    lines: Vec<String>,
    // In-flight assistant message being reassembled from deltas.
    cur_text: String,
    cur_thinking: String,
    /// Epoch ms of the first and most recent reasoning delta in the in-flight
    /// message, so a member's reasoning block persists the same duration the
    /// main runtime records (see `BlockState::push_thinking`). `None` until
    /// the first delta — a message with no reasoning must persist no span.
    cur_thinking_span: Option<(i64, i64)>,
    cur_tools: Vec<(String, String, Value)>,
    streaming_open: bool,
}

impl MemberEventMirror {
    fn new(
        bus: Arc<TeamBus>,
        repo_path: &str,
        agent_id: &str,
        run_id: Option<String>,
        seed: Vec<String>,
    ) -> Self {
        let ws = ProjectWorkspace::resolve(repo_path);
        let project_id = ws.project_id().to_string();
        Self {
            bus,
            ws,
            project_id,
            agent_id: agent_id.to_string(),
            run_id,
            seq: AtomicU64::new(0),
            lines: seed,
            cur_text: String::new(),
            cur_thinking: String::new(),
            cur_thinking_span: None,
            cur_tools: Vec::new(),
            streaming_open: false,
        }
    }

    fn frame(&self, kind: &str, event: &str, delta: &str) {
        self.bus.stream(
            &self.project_id,
            &TeamStreamDelta {
                agent_id: self.agent_id.clone(),
                phase: "working".to_string(),
                kind: kind.to_string(),
                event: event.to_string(),
                delta: delta.to_string(),
                run_id: self.run_id.clone(),
                seq: self.seq.fetch_add(1, Ordering::Relaxed),
            },
        );
    }

    fn open_if_needed(&mut self) {
        if !self.streaming_open {
            self.frame("text", "start", "");
            self.streaming_open = true;
        }
    }

    fn push_line(&mut self, msg: &ConversationMessage) {
        if let Ok(line) = serde_json::to_string(msg) {
            self.lines.push(line);
            let _ = self.ws.write_agent_session(&self.agent_id, &self.lines);
        }
    }

    fn finalize_assistant(&mut self) {
        let mut blocks = Vec::new();
        if !self.cur_thinking.is_empty() {
            blocks.push(ContentBlock::Thinking {
                text: std::mem::take(&mut self.cur_thinking),
                signature: None,
                duration_ms: self
                    .cur_thinking_span
                    .take()
                    .map(|(start, end)| end.saturating_sub(start).max(0) as u64),
            });
        }
        if !self.cur_text.is_empty() {
            blocks.push(ContentBlock::Text {
                text: std::mem::take(&mut self.cur_text),
            });
        }
        for (id, name, input) in std::mem::take(&mut self.cur_tools) {
            blocks.push(ContentBlock::ToolUse { id, name, input });
        }
        if !blocks.is_empty() {
            let msg = ConversationMessage {
                event_id: None,
                role: MessageRole::Assistant,
                blocks,
                usage: None,
                timestamp: Utc::now().timestamp_millis(),
                attached_selected_elements: None,
                attached_prompt_chips: None,
                aurora_context: None,
                model: None,
            };
            self.push_line(&msg);
        }
        if self.streaming_open {
            self.frame("text", "end", "");
            self.streaming_open = false;
        }
    }

    fn on_event(&mut self, event: AssistantEvent) {
        match event {
            AssistantEvent::TextDelta { delta } => {
                self.open_if_needed();
                if !delta.is_empty() {
                    self.frame("text", "delta", &delta);
                    self.cur_text.push_str(&delta);
                }
            }
            AssistantEvent::Thinking { text, .. } => {
                self.open_if_needed();
                if !text.is_empty() {
                    self.frame("thinking", "delta", &text);
                    self.cur_thinking.push_str(&text);
                    let now = crate::api::provider_kernel_adapter::now_unix_ms();
                    match &mut self.cur_thinking_span {
                        Some((_, end)) => *end = now,
                        None => self.cur_thinking_span = Some((now, now)),
                    }
                }
            }
            AssistantEvent::ToolUse { id, name, input } => {
                self.cur_tools.push((id, name, input));
            }
            AssistantEvent::MessageStop { .. } => {
                self.finalize_assistant();
            }
            AssistantEvent::ToolExecutionResult {
                id,
                content,
                is_error,
                ..
            } => {
                // A tool result can land while the assistant message that
                // requested it is already finalized — mirror it as its own
                // tool message, exactly how the session stores it.
                let msg = ConversationMessage {
                    event_id: None,
                    role: MessageRole::Tool,
                    blocks: vec![ContentBlock::ToolResult {
                        tool_use_id: id,
                        content,
                        is_error: Some(is_error),
                    }],
                    usage: None,
                    timestamp: Utc::now().timestamp_millis(),
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                    aurora_context: None,
                    model: None,
                };
                self.push_line(&msg);
            }
            AssistantEvent::QueuedMessageInjected { text, .. } => {
                // A mailbox message reached the model — show it in the
                // transcript where it actually landed.
                let msg = ConversationMessage::user_text(text, Utc::now().timestamp_millis());
                self.push_line(&msg);
            }
            _ => {}
        }
    }

    /// Settle anything still open (a turn that errored mid-message).
    fn finish(&mut self) -> Vec<String> {
        self.finalize_assistant();
        std::mem::take(&mut self.lines)
    }
}

// ─── the actor ────────────────────────────────────────────────────────────

/// Everything `run_member` needs, bundled so dispatch stays readable.
pub(crate) struct MemberRun {
    pub usage_ledger: Option<Arc<crate::usage_ledger::UsageLedger>>,
    pub bus: Arc<TeamBus>,
    pub comms: Arc<TeamComms>,
    pub repo_path: String,
    pub run_id: Option<String>,
    pub goal: String,
    pub record: AgentRecord,
    pub task: String,
    pub owned: Vec<String>,
    pub roster: Vec<(String, String)>,
    pub provider: ProviderConfigSnapshot,
    pub cancel: CancellationToken,
}

/// Drive one member start-to-finish and return its report. Never panics the
/// run: every failure path produces an honest `failed` report.
pub(crate) async fn run_member(run: MemberRun) -> MemberReport {
    let agent_id = run.record.id.clone();
    let role = run.record.role.clone();

    let session = match TeamSession::open(&run.repo_path) {
        Ok(s) => s,
        Err(e) => {
            return MemberReport {
                agent_id,
                role,
                status: ReportStatus::Failed,
                summary: format!("could not open the team brain: {e}"),
                changed_files: Vec::new(),
            }
        }
    };

    let ctx = Arc::new(MemberCtx {
        bus: run.bus.clone(),
        comms: run.comms.clone(),
        session,
        agent_id: agent_id.clone(),
        role: role.clone(),
        run_id: run.run_id.clone(),
        roster: run.roster.clone(),
        changed: Mutex::new(Vec::new()),
        report: Mutex::new(None),
    });

    ctx.set_status(AgentStatus::Working).await;
    let report = drive_member(&run, &ctx).await;
    // Terminal state on the roster mirrors the report.
    ctx.set_status(match report.status {
        ReportStatus::Done => AgentStatus::Done,
        ReportStatus::Blocked => AgentStatus::Blocked,
        ReportStatus::Failed => AgentStatus::Failed,
    })
    .await;
    // Late messages to this member now fail fast as unreachable.
    run.comms.unregister(&agent_id);
    report
}

async fn drive_member(run: &MemberRun, ctx: &Arc<MemberCtx>) -> MemberReport {
    let agent_id = &ctx.agent_id;

    let registry = Arc::new(member_registry(ctx));
    let client = build_api_client(&run.provider);
    let config = RuntimeConfig {
        // Keep wire identity separate from accounting's provider-qualified model.
        wire_model: run.provider.model.clone(),
        // A team member works a project. Team is a Build-side feature and has
        // no reachable path from Aurora Chat.
        execution_mode_is_chat: false,
        max_iterations: Some(MEMBER_MAX_ITERATIONS),
        system_prompt: Some(member_system_prompt(&ctx.role, &run.owned, &run.roster)),
        default_max_output_tokens: resolved_max_tokens(&run.provider),
        reasoning: run
            .provider
            .reasoning
            .clone()
            .unwrap_or_else(|| ReasoningConfig::legacy(run.provider.supports_thinking, None)),
        default_temperature: run.provider.default_temperature,
        context_window: Some(MEMBER_CONTEXT_WINDOW),
        compaction_threshold: Some(MEMBER_COMPACTION_THRESHOLD),
        compaction_summary_budget: 4096,
        // Members stay inside the project whatever the lead was granted.
        // `MemberRun` carries no access mode — threading the user's choice
        // through the dispatcher is the follow-up that makes a team run match
        // its lead; until then the narrower answer is the safe one.
        workspace_access: crate::agent_runtime::tool_executor::WorkspaceAccess::Workspace,
        // Members run their own provider — price their stored reasoning by
        // what THAT provider replays, not the lead's.
        reasoning_replay: crate::api::reasoning_replay_for(
            run.provider.effective_provider_type(),
            &run.provider.model,
            &run.provider.base_url,
            run.provider.reasoning.as_ref().map_or(
                crate::agent_runtime::api_client::ReasoningReplayMode::Auto,
                |reasoning| reasoning.replay,
            ),
            run.provider.custom_params.as_ref(),
        ),
    };
    let runtime = ConversationRuntime::new(client, registry, config);

    let mut session = Session::new(format!("team-{agent_id}"))
        .with_workspace_root(run.repo_path.clone())
        .with_model(if run.provider.provider_id.is_empty() {
            run.provider.model.clone()
        } else {
            format!("{}:{}", run.provider.provider_id, run.provider.model)
        });
    session.usage_ledger = run.usage_ledger.clone();

    // Mailbox pump: deliver arriving messages into the session's queued slot
    // so they inject at the member's next tool-result boundary. Coalesces —
    // the slot holds one pending message; new arrivals append to it.
    let mailbox = run.comms.register(agent_id);
    let queue_slot = session.queue_slot();
    let pump = tokio::spawn(pump_mailbox(mailbox, queue_slot));

    let mut lines_seed = Vec::new();
    let first_message = ConversationMessage::user_text(
        initial_task_message(&run.goal, &run.task, &ctx.session, agent_id),
        Utc::now().timestamp_millis(),
    );
    if let Ok(line) = serde_json::to_string(&first_message) {
        lines_seed.push(line);
    }

    let mut next_message = Some(first_message);
    let mut wrapup_sent = false;
    let mut turns = 0usize;
    let mut engine_error: Option<String> = None;
    let mut mirror_lines = lines_seed;

    while let Some(user_message) = next_message.take() {
        turns += 1;
        if turns > MEMBER_MAX_TURNS {
            engine_error = Some(format!(
                "stopped after {MEMBER_MAX_TURNS} turns without a report"
            ));
            break;
        }
        if run.cancel.is_cancelled() {
            engine_error = Some("cancelled".to_string());
            break;
        }

        // Fresh mirror per turn, seeded with everything already on disk.
        let (tx, mut rx) = mpsc::channel::<AgentEventEnvelope>(256);
        let mut mirror = MemberEventMirror::new(
            run.bus.clone(),
            &run.repo_path,
            agent_id,
            run.run_id.clone(),
            mirror_lines.clone(),
        );
        let mirror_task = tokio::spawn(async move {
            while let Some(envelope) = rx.recv().await {
                mirror.on_event(envelope.event);
            }
            mirror.finish()
        });

        let outcome = runtime
            .run_turn(&mut session, user_message, tx, run.cancel.clone())
            .await;
        // The event sender is dropped by run_turn returning; the mirror task
        // drains and settles. Await it BEFORE the authoritative rewrite so
        // the two writers never interleave.
        if let Ok(lines) = mirror_task.await {
            mirror_lines = lines;
        }

        // Authoritative transcript: the session's own messages.
        let authoritative: Vec<String> = session
            .messages()
            .iter()
            .filter_map(|m| serde_json::to_string(m).ok())
            .collect();
        if !authoritative.is_empty() {
            let _ = ctx
                .session
                .workspace()
                .write_agent_session(agent_id, &authoritative);
            mirror_lines = authoritative;
        }

        if let Err(e) = outcome {
            engine_error = Some(match e {
                crate::agent_runtime::error::RuntimeError::Cancelled => "cancelled".to_string(),
                other => format!("engine error: {other}"),
            });
            break;
        }

        if ctx.filed_report().is_some() {
            break;
        }

        // Turn ended without a report. A pending mailbox message means a
        // teammate/Lead reached out right at the boundary — handle it as the
        // next turn. Otherwise ask once for the report, then give up honestly.
        if let Some(queued) = session.take_queued_message() {
            next_message = Some(ConversationMessage::user_text(
                queued.text,
                Utc::now().timestamp_millis(),
            ));
        } else if !wrapup_sent {
            wrapup_sent = true;
            next_message = Some(ConversationMessage::user_text(
                "Your turn ended without a report. If your assignment is complete, call report \
                 with status \"done\" and a concrete summary; if you cannot complete it, call \
                 report with status \"blocked\" and say exactly what blocks you."
                    .to_string(),
                Utc::now().timestamp_millis(),
            ));
        }
    }

    pump.abort();

    let changed_files = ctx.changed_snapshot();
    match (ctx.filed_report(), engine_error) {
        (Some((status, summary)), _) => MemberReport {
            agent_id: agent_id.clone(),
            role: ctx.role.clone(),
            status,
            summary,
            changed_files,
        },
        (None, Some(err)) => MemberReport {
            agent_id: agent_id.clone(),
            role: ctx.role.clone(),
            status: ReportStatus::Failed,
            summary: format!("no report was filed — {err}"),
            changed_files,
        },
        (None, None) => MemberReport {
            agent_id: agent_id.clone(),
            role: ctx.role.clone(),
            status: ReportStatus::Failed,
            summary: "no report was filed — the member went silent".to_string(),
            changed_files,
        },
    }
}

/// Drain a member's mailbox into its session queue slot. The slot holds one
/// pending injection; concurrent arrivals coalesce by appending, so nothing
/// is ever dropped on the floor.
async fn pump_mailbox(
    mut rx: mpsc::UnboundedReceiver<super::mailbox::MemberMessage>,
    slot: crate::agent_runtime::session::QueueSlot,
) {
    while let Some(msg) = rx.recv().await {
        let rendered = match &msg.question_id {
            Some(qid) => format!(
                "[Question from {} — answer with the reply tool, question_id \"{qid}\"]\n{}",
                msg.from, msg.text
            ),
            None => format!("[Message from {}]\n{}", msg.from, msg.text),
        };
        if let Ok(mut guard) = slot.lock() {
            match guard.as_mut() {
                Some(existing) => {
                    existing.text.push_str("\n\n");
                    existing.text.push_str(&rendered);
                }
                None => {
                    *guard = Some(crate::agent_runtime::session::QueuedUserMessage {
                        text: rendered,
                        display_text: None,
                        chips: None,
                        // Mailbox traffic carries its own `[Message from …]`
                        // framing — the user-mid-turn preamble would lie.
                        mid_turn: false,
                        // A teammate's message IS somebody's words, so it keeps
                        // the message row; only machine events become beats.
                        origin: crate::agent_runtime::types::InjectedOrigin::User,
                        queued_at_ms: Utc::now().timestamp_millis(),
                    });
                }
            }
        }
    }
}

// ─── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_ctx(dir: &std::path::Path) -> Arc<MemberCtx> {
        let ws = ProjectWorkspace::at_root("pid-member", dir.join("brain"));
        ws.ensure_scaffold(dir.to_str().unwrap(), None).unwrap();
        let session = TeamSession::with_workspace(ws);
        Arc::new(MemberCtx {
            bus: Arc::new(TeamBus::headless()),
            comms: Arc::new(TeamComms::new()),
            session,
            agent_id: "nina-1".into(),
            role: "api-owner".into(),
            run_id: Some("run-1".into()),
            roster: vec![
                ("nina-1".into(), "api-owner".into()),
                ("marco-2".into(), "ui-owner".into()),
            ],
            changed: Mutex::new(Vec::new()),
            report: Mutex::new(None),
        })
    }

    fn tool_ctx() -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            workspace_access: Default::default(),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    #[test]
    fn member_registry_has_the_full_professional_toolset() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let reg = member_registry(&ctx);
        let names = reg.names();
        for expected in [
            "file_read",
            "file_write",
            "file_edit",
            "move_path",
            "delete_path",
            "folder_create",
            "glob",
            "grep",
            "workspace_tree",
            "auroro_websearch",
            "shell_execute",
            "send_message",
            "ask_member",
            "ask_lead",
            "reply",
            "publish_contract",
            "report",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
        // No stale aliases, no dead names — the roster is exactly the tools.
        assert_eq!(names.len(), 17, "roster drifted: {names:?}");
    }

    #[tokio::test]
    async fn report_tool_files_a_done_report_and_rejects_thin_summaries() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let tool = ReportTool(ctx.clone());

        let err = tool
            .execute(json!({"status": "done", "summary": "did it"}), &tool_ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
        assert!(ctx.filed_report().is_none());

        tool.execute(
            json!({"status": "done", "summary": "Implemented the /api/orders cursor pagination and verified with the integration test suite (12 passing)."}),
            &tool_ctx(),
        )
        .await
        .unwrap();
        let (status, summary) = ctx.filed_report().expect("filed");
        assert_eq!(status, ReportStatus::Done);
        assert!(summary.contains("pagination"));
    }

    #[tokio::test]
    async fn report_rejects_engine_only_status() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let tool = ReportTool(ctx);
        let err = tool
            .execute(
                json!({"status": "failed", "summary": "a summary long enough to pass the gate"}),
                &tool_ctx(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn ask_member_refuses_the_lead_and_unknown_names() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let tool = AskMemberTool(ctx);

        let err = tool
            .execute(json!({"to": "lead", "question": "?"}), &tool_ctx())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ask_lead"));

        let err = tool
            .execute(json!({"to": "nobody", "question": "?"}), &tool_ctx())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("ui-owner"),
            "roster in error: {err}"
        );
    }

    #[tokio::test]
    async fn ask_member_gets_the_real_answer_from_the_peer_mailbox() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let mut peer_rx = ctx.comms.register("marco-2");
        let comms = ctx.comms.clone();
        let tool = AskMemberTool(ctx);

        let answerer = tokio::spawn(async move {
            let q = peer_rx.recv().await.expect("question delivered");
            let qid = q.question_id.expect("reply ticket");
            comms.resolve(&qid, "PaginationCursor, exported from src/types.ts");
        });

        let out = tool
            .execute(
                json!({"to": "ui-owner", "question": "what type do I return?"}),
                &tool_ctx(),
            )
            .await
            .unwrap();
        answerer.await.unwrap();
        assert!(out.contains("marco-2 replied"), "{out}");
        assert!(out.contains("PaginationCursor"), "{out}");
    }

    #[tokio::test]
    async fn ask_member_is_honest_when_the_peer_is_gone() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        let tool = AskMemberTool(ctx);
        let out = tool
            .execute(json!({"to": "ui-owner", "question": "?"}), &tool_ctx())
            .await
            .unwrap();
        assert!(out.contains("already finished"), "{out}");
    }

    #[tokio::test]
    async fn scope_gate_blocks_writes_into_a_peers_scope_and_names_the_way_out() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path());
        // marco owns src/ui; nina owns src/api.
        {
            let bus = TeamBus::headless();
            ctx.session
                .convene(
                    &bus,
                    super::super::orchestrator::ConveneRequest {
                        lead_model: None,
                        stack: None,
                        agents: vec![],
                    },
                    4,
                )
                .unwrap();
        }
        // Register both on the roster manually via scope assignments.
        {
            let bus = TeamBus::headless();
            let mut team = ctx.session.workspace().read_team().unwrap().unwrap();
            for (id, role) in &ctx.roster {
                team.agents.push(AgentRecord {
                    id: id.clone(),
                    role: role.clone(),
                    model: None,
                    status: AgentStatus::Idle,
                });
            }
            ctx.session.workspace().write_team(&team).unwrap();
            ctx.session
                .assign_scope(&bus, "nina-1", vec!["src/api".into()], vec![])
                .unwrap();
            ctx.session
                .assign_scope(&bus, "marco-2", vec!["src/ui".into()], vec![])
                .unwrap();
        }

        struct FakeWrite;
        #[async_trait]
        impl ToolExecutor for FakeWrite {
            fn name(&self) -> &str {
                "file_write"
            }
            fn schema(&self) -> ToolSchema {
                ToolSchema {
                    name: "file_write".into(),
                    description: "t".into(),
                    input_schema: json!({"type": "object"}),
                }
            }
            async fn execute(&self, _i: Value, _c: &ToolContext) -> Result<String, ToolError> {
                Ok("written".into())
            }
        }

        let gated = ScopeGatedTool::new(Arc::new(FakeWrite), ctx.clone());

        // A peer-owned path is refused and the inner tool never runs.
        let err = gated
            .execute(
                json!({"path": "src/ui/App.tsx", "content": "x"}),
                &tool_ctx(),
            )
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("refused"), "{msg}");
        assert!(
            msg.contains("ask_member") || msg.contains("ask_lead"),
            "{msg}"
        );
        assert!(ctx.changed_snapshot().is_empty());

        // An owned path passes and the change is recorded.
        gated
            .execute(
                json!({"path": "src/api/orders.ts", "content": "x"}),
                &tool_ctx(),
            )
            .await
            .unwrap();
        assert_eq!(
            ctx.changed_snapshot(),
            vec!["src/api/orders.ts".to_string()]
        );
    }

    #[test]
    fn system_prompt_names_scope_team_and_the_report_contract() {
        let prompt = member_system_prompt(
            "api-owner",
            &["src/api".to_string()],
            &[
                ("nina-1".to_string(), "api-owner".to_string()),
                ("marco-2".to_string(), "ui-owner".to_string()),
            ],
        );
        assert!(prompt.contains("src/api"));
        assert!(prompt.contains("@marco-2"));
        assert!(prompt.contains("report"));
        assert!(
            prompt.contains("changing zero files is expected") || prompt.contains("zero files")
        );
    }

    #[tokio::test]
    async fn pump_coalesces_multiple_arrivals_into_the_single_slot() {
        let comms = TeamComms::new();
        let rx = comms.register("x");
        let slot = crate::agent_runtime::session::empty_queue_slot();
        let pump = tokio::spawn(pump_mailbox(rx, slot.clone()));

        comms.send_to("x", "lead", "first note").unwrap();
        comms.send_to("x", "marco-2", "second note").unwrap();
        // Give the pump a moment to drain both.
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            if slot
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|m| m.text.contains("second note")))
                .unwrap_or(false)
            {
                break;
            }
        }
        let text = slot.lock().unwrap().as_ref().unwrap().text.clone();
        assert!(text.contains("[Message from lead]"), "{text}");
        assert!(
            text.contains("first note") && text.contains("second note"),
            "{text}"
        );
        pump.abort();
    }
}
