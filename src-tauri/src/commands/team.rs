//! Tauri commands for the Agent Team.
//!
//! These are the IPC entry points the frontend team client
//! (`src/services/team-client.ts`) calls. They are thin wrappers — all the
//! real work lives in [`crate::agent_runtime::team`]. The whole brain lives
//! in `~/.aurora/projects/<projectId>/`, not SQLite.
//!
//! The surface is deliberately small now:
//!
//! - brain reads (`team_get_state`, `team_channel_tail`, transcript, …);
//! - the Lead's control tools (`team_dispatch`, `team_lead_message`,
//!   `team_remove_agent`, `team_disband`, `team_grant_scope`);
//! - the run status / ack pair the completion notifier drives;
//! - the **lead inbox** (`team_lead_inbox` / `team_lead_reply`): questions
//!   members routed to the real chat Lead, and the Lead's answers back.
//!
//! The old phased commands (planning round, build round, integration gate,
//! per-step board mutations) are gone with the phases themselves — the
//! engine owns that lifecycle end to end.

use std::sync::Arc;

use tauri::State;
use uuid::Uuid;

use crate::agent_runtime::team::{
    now_rfc3339, project_id_for, ChannelEvent, ChannelEventKind, DispatchMember, LeadQuestion,
    ProjectWorkspace, ScopeDecision, TeamBus, TeamDispatcher, TeamProjectState, TeamRunStatus,
    TeamSession, DEFAULT_CHANNEL_TAIL, LEAD_AGENT_ID,
};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

/// Resolve the stable `projectId` for a repo path without touching disk.
#[tauri::command]
pub async fn team_resolve_project_id(repo_path: String) -> Result<String, String> {
    Ok(project_id_for(&repo_path))
}

/// Scaffold (or open) a project's shared brain and return its full state.
/// Idempotent.
#[tauri::command]
pub async fn team_init(
    repo_path: String,
    lead_model: Option<String>,
) -> Result<TeamProjectState, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.ensure_scaffold(&repo_path, lead_model)
        .map_err(|e| e.to_string())?;
    ws.load_state(Some(DEFAULT_CHANNEL_TAIL))
        .map_err(|e| e.to_string())
}

/// Read a project's brain snapshot. Safe to call before `team_init`.
#[tauri::command]
pub async fn team_get_state(
    repo_path: String,
    channel_limit: Option<usize>,
) -> Result<TeamProjectState, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.load_state(channel_limit.or(Some(DEFAULT_CHANNEL_TAIL)))
        .map_err(|e| e.to_string())
}

/// Read the tail of the team channel (most-recent events, oldest-first).
#[tauri::command]
pub async fn team_channel_tail(
    repo_path: String,
    limit: Option<usize>,
) -> Result<Vec<ChannelEvent>, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.read_channel(limit.or(Some(DEFAULT_CHANNEL_TAIL)))
        .map_err(|e| e.to_string())
}

/// The distinct chat/thread ids that have ever dispatched a team run for
/// this project (left-rail badge). Never errors on a missing brain.
#[tauri::command]
pub async fn team_origin_threads(repo_path: String) -> Result<Vec<String>, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    let events = ws.read_channel(None).map_err(|e| e.to_string())?;
    let mut seen = std::collections::BTreeSet::new();
    for event in events {
        if let Some(meta) = event.meta.as_ref() {
            if let Some(tid) = meta.get("originThreadId").and_then(|v| v.as_str()) {
                let tid = tid.trim();
                if !tid.is_empty() {
                    seen.insert(tid.to_string());
                }
            }
        }
    }
    Ok(seen.into_iter().collect())
}

/// Post one event to the team channel (persist + broadcast via the bus).
#[tauri::command]
pub async fn team_post_channel_event(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    author: String,
    kind: ChannelEventKind,
    body: String,
    meta: Option<serde_json::Value>,
) -> Result<ChannelEvent, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.ensure_scaffold(&repo_path, None)
        .map_err(|e| e.to_string())?;
    let event = ChannelEvent {
        id: Uuid::new_v4().to_string(),
        ts: now_rfc3339(),
        author,
        kind,
        body,
        meta,
    };
    bus.post(&ws, event).map_err(|e| e.to_string())
}

// ── Lead control ────────────────────────────────────────────────────────

/// Reload the brain snapshot after a mutation.
fn snapshot(session: &TeamSession) -> Result<TeamProjectState, String> {
    session
        .workspace()
        .load_state(Some(DEFAULT_CHANNEL_TAIL))
        .map_err(|e| e.to_string())
}

/// Remove/dismiss a member; its scope is released and its tasks unassigned.
#[tauri::command]
pub async fn team_remove_agent(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent_id: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .remove_agent(&bus, &agent_id)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Stop the whole team run (graceful cancel → Disbanded; brain stays on disk).
#[tauri::command]
pub async fn team_disband(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
) -> Result<TeamProjectState, String> {
    dispatcher.cancel_and_post(&bus, &repo_path, "Team run cancelled by user.");
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session.disband(&bus).map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Ask the scope write-guard whether `agent_id` may write `path` (read-only
/// — the Team view uses it to explain a refused edit).
#[tauri::command]
pub async fn team_check_scope(
    repo_path: String,
    agent_id: String,
    path: String,
) -> Result<ScopeDecision, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .check_write(&agent_id, &path)
        .map_err(|e| e.to_string())
}

/// The Lead grants a member write access to additional paths. Structured —
/// no magic text directives. The partition stays non-overlapping (granted
/// paths are taken from any previous owner) and the grant is posted to the
/// channel so the whole team sees the transfer.
#[tauri::command]
pub async fn team_grant_scope(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent_id: String,
    paths: Vec<String>,
) -> Result<TeamProjectState, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("'paths' must name at least one repo-relative path".into());
    }
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;

    // Serialize with the live run's brain mutations when one is active.
    let comms = dispatcher.comms_for(&project_id_for(&repo_path));
    let _guard = match &comms {
        Some(c) => Some(c.lock_brain().await),
        None => None,
    };

    // Extend (not replace) the member's current scope.
    let mut owned = session
        .workspace()
        .read_scope_map()
        .map_err(|e| e.to_string())?
        .and_then(|s| {
            s.assignments
                .into_iter()
                .find(|a| a.agent_id == agent_id)
                .map(|a| (a.owned_paths, a.owned_contracts))
        })
        .unwrap_or_default();
    for p in &paths {
        if !owned.0.contains(p) {
            owned.0.push(p.clone());
        }
    }
    session
        .assign_scope(&bus, &agent_id, owned.0, owned.1)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

// ── Lead ↔ member messaging ─────────────────────────────────────────────

/// Post a Lead message to the team chat AND deliver it into the live
/// members' conversations (all of them, or one specific member). This is
/// real steering: the member reads it mid-work, not "maybe sees the
/// channel tail eventually".
#[tauri::command]
pub async fn team_lead_message(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    text: String,
    to: Option<String>,
) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("'text' must not be empty".into());
    }
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.ensure_scaffold(&repo_path, None)
        .map_err(|e| e.to_string())?;
    bus.post(
        &ws,
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::Message,
            body: text.clone(),
            meta: Some(serde_json::json!({ "phase": "working", "chat": true })),
        },
    )
    .map_err(|e| e.to_string())?;

    let mut delivered: Vec<String> = Vec::new();
    if let Some(comms) = dispatcher.comms_for(&project_id_for(&repo_path)) {
        match to.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(target) => {
                if comms.send_to(target, LEAD_AGENT_ID, &text).is_ok() {
                    delivered.push(target.to_string());
                }
            }
            None => delivered = comms.broadcast(LEAD_AGENT_ID, &text),
        }
    }
    Ok(serde_json::json!({ "delivered": delivered }))
}

/// Questions members routed to the real Lead and are currently waiting on
/// (A2A `input-required`). The completion notifier polls this and injects
/// each question into the Lead's conversation exactly once.
#[tauri::command]
pub async fn team_lead_inbox(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    repo_path: String,
) -> Result<Vec<LeadQuestion>, String> {
    Ok(dispatcher
        .comms_for(&project_id_for(&repo_path))
        .map(|c| c.lead_pending())
        .unwrap_or_default())
}

/// The Lead answers a member's parked question. Resolves the waiting
/// member (it resumes immediately) and posts the answer to the channel.
/// Returns false when the ticket is unknown or the member stopped waiting
/// — the posted answer still lands in the chat either way.
#[tauri::command]
pub async fn team_lead_reply(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    question_id: String,
    text: String,
) -> Result<bool, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("'text' must not be empty".into());
    }
    let ws = ProjectWorkspace::resolve(&repo_path);
    let _ = bus.post(
        &ws,
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::Message,
            body: text.clone(),
            meta: Some(serde_json::json!({ "phase": "working", "replyTo": question_id })),
        },
    );
    Ok(dispatcher
        .comms_for(&project_id_for(&repo_path))
        .map(|c| c.lead_reply(&question_id, &text))
        .unwrap_or(false))
}

// ── Background dispatch ─────────────────────────────────────────────────

/// Dispatch the Lead-defined team in the background and return the current
/// (just-reset) brain snapshot. Does NOT wait for the run. Rejected if a
/// run is already in progress for this workspace.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_dispatch(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    goal: String,
    members: Vec<DispatchMember>,
    lead_provider_config: crate::api::ProviderConfigSnapshot,
    team_provider_config: crate::api::ProviderConfigSnapshot,
    max_size: usize,
    origin_thread_id: Option<String>,
    origin_surface: Option<String>,
) -> Result<TeamProjectState, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    ws.ensure_scaffold(&repo_path, None)
        .map_err(|e| e.to_string())?;

    dispatcher.inner().dispatch(
        bus.inner().clone(),
        repo_path.clone(),
        goal,
        members,
        lead_provider_config,
        team_provider_config,
        max_size,
        origin_thread_id,
        origin_surface,
    )?;

    ws.load_state(Some(DEFAULT_CHANNEL_TAIL))
        .map_err(|e| e.to_string())
}

/// Read the live background-run status for a workspace — lifecycle, live
/// per-member states, and (once terminal) the member reports.
#[tauri::command]
pub async fn team_run_status(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    repo_path: String,
) -> Result<TeamRunStatus, String> {
    Ok(dispatcher.status(&project_id_for(&repo_path)))
}

/// Mark a terminal run's completion report as delivered to the Lead
/// (exactly-once across window reloads). Returns the fresh status.
#[tauri::command]
pub async fn team_run_ack(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    repo_path: String,
    run_id: Option<String>,
) -> Result<TeamRunStatus, String> {
    let project_id = project_id_for(&repo_path);
    dispatcher.ack(&project_id, run_id.as_deref());
    Ok(dispatcher.status(&project_id))
}

// ── Per-agent transcript (the team-window's individual agent view) ──────

/// Caps so a single huge file read can't bloat the transcript payload.
const TRANSCRIPT_TEXT_CAP: usize = 6000;
const TRANSCRIPT_INPUT_CAP: usize = 2000;

/// One tool call an agent made (what it's "calling").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub name: String,
    pub input: String,
}

/// One tool result an agent received (what it "got back").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult {
    pub content: String,
    pub is_error: bool,
}

/// One turn in an agent's transcript for the per-agent window view.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    /// "assistant" | "user" | "tool" | "system".
    pub role: String,
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<AgentToolCall>,
    pub tool_results: Vec<AgentToolResult>,
}

/// Clamp a long string for display, appending a truncation marker.
fn clamp_display(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut t: String = s.chars().take(max).collect();
        t.push_str("\n…(truncated)…");
        t
    } else {
        s.to_string()
    }
}

/// Read one agent's transcript (`agents/<id>/session.jsonl`) as display
/// turns. Empty until the agent starts. Safe to poll.
#[tauri::command]
pub async fn team_get_agent_transcript(
    repo_path: String,
    agent_id: String,
) -> Result<Vec<AgentTurn>, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    let lines = ws
        .read_agent_session(&agent_id)
        .map_err(|e| e.to_string())?;
    let mut turns = Vec::with_capacity(lines.len());
    for line in lines {
        let Ok(msg) = serde_json::from_str::<ConversationMessage>(&line) else {
            continue;
        };
        let role = match msg.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        }
        .to_string();

        let mut text = String::new();
        let mut thinking = String::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        for block in &msg.blocks {
            match block {
                ContentBlock::Text { text: t } => {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(t);
                }
                ContentBlock::Thinking { text: t, .. } => {
                    if !thinking.is_empty() {
                        thinking.push_str("\n\n");
                    }
                    thinking.push_str(t);
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    tool_calls.push(AgentToolCall {
                        name: name.clone(),
                        input: clamp_display(&input.to_string(), TRANSCRIPT_INPUT_CAP),
                    });
                }
                ContentBlock::ToolResult {
                    content, is_error, ..
                } => {
                    tool_results.push(AgentToolResult {
                        content: clamp_display(content, TRANSCRIPT_TEXT_CAP),
                        is_error: is_error.unwrap_or(false),
                    });
                }
                // A directly made picture reads as the one line the model
                // would see: a teammate's transcript is text.
                ContentBlock::Image { .. } => {
                    if let Some(line) = block.image_as_text() {
                        if !text.is_empty() {
                            text.push_str("\n\n");
                        }
                        text.push_str(&line);
                    }
                }
                // Compaction markers and runtime notices carry no
                // transcript-visible content for a teammate's turn.
                ContentBlock::Compaction { .. } | ContentBlock::Notice { .. } => {}
                // A process ending shows as the one line the transcript uses,
                // not the model-facing detail with its ids and log paths.
                ContentBlock::ProcessEvent { summary, .. } => {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(summary);
                }
            }
        }

        turns.push(AgentTurn {
            role,
            text: clamp_display(&text, TRANSCRIPT_TEXT_CAP),
            thinking: clamp_display(&thinking, TRANSCRIPT_TEXT_CAP),
            tool_calls,
            tool_results,
        });
    }
    Ok(turns)
}
