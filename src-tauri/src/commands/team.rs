//! Tauri commands for the Agent Team shared brain + TeamBus (Phase 1).
//!
//! These are the IPC entry points the frontend team client
//! (`src/services/team-client.ts`) calls to scaffold a project's brain,
//! read its current state, and post to the team channel. They are thin
//! wrappers — all the real work lives in
//! [`crate::agent_runtime::team`] (the workspace store + bus). The whole
//! brain lives in `~/.aurora/projects/<projectId>/`, not SQLite
//! (ground truth §18).
//!
//! Posting goes through the [`TeamBus`] in managed state so the event is
//! persisted to `channel/events.jsonl` **and** broadcast on the
//! `"team_event"` Tauri channel in one path (§7).
//!
//! Tauri exposes each snake_case parameter to JS as camelCase
//! (`repo_path` → `repoPath`, `lead_model` → `leadModel`, …).

use std::sync::Arc;

use tauri::State;
use uuid::Uuid;

use crate::agent_runtime::team::{
    now_rfc3339, project_id_for, AgentSpec, AgentStatus, ChannelEvent, ChannelEventKind,
    ConveneRequest, DispatchMember, GateCommands, GateStatus, ProjectWorkspace, ReviewVerdict,
    ScopeDecision, TaskStatus, TeamBus, TeamDispatcher, TeamProjectState, TeamRunStatus,
    TeamSession, DEFAULT_CHANNEL_TAIL,
};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

/// Resolve the stable `projectId` for a repo path without touching disk.
/// Useful for the frontend to key its team store before init.
#[tauri::command]
pub async fn team_resolve_project_id(repo_path: String) -> Result<String, String> {
    Ok(project_id_for(&repo_path))
}

/// Scaffold (or open) a project's shared brain and return its full state.
///
/// Idempotent: calling it on an already-initialized project just returns
/// the existing brain — `project.json`'s `created_at` and `repo_path` are
/// preserved (see [`ProjectWorkspace::ensure_scaffold`]).
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

/// Read a project's brain snapshot. Safe to call before `team_init` —
/// an un-scaffolded project returns an uninitialized snapshot
/// (`initialized: false`) rather than erroring, so the UI can render an
/// empty team view immediately.
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

/// The distinct chat/thread ids that have ever dispatched a team run for this
/// project, read from the durable channel log (`meta.originThreadId`, stamped on
/// each run's lifecycle events). Powers the left-rail "this chat has team work"
/// badge. Returns an empty list for a project with no brain or no runs — never
/// errors on a missing brain (an un-scaffolded project simply has no history).
#[tauri::command]
pub async fn team_origin_threads(repo_path: String) -> Result<Vec<String>, String> {
    let ws = ProjectWorkspace::resolve(&repo_path);
    let events = ws.read_channel(None).map_err(|e| e.to_string())?;
    // De-dupe + stable order so the frontend cache key stays stable across reads.
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

/// Post one event to the team channel: persist it to `events.jsonl` and
/// broadcast it live on the `"team_event"` channel via the [`TeamBus`].
///
/// The brain is scaffolded on demand so posting to a not-yet-initialized
/// project can never silently drop the event. The runtime stamps the id
/// and timestamp — the caller supplies only author/kind/body/meta.
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

// ─── Lead team-control commands (Phase 2a) ────────────────────────────
//
// These are the IPC entry points behind the Lead's team-control tools
// (ground truth §7). Each drives the [`TeamSession`] state machine over
// the brain, then returns a fresh [`TeamProjectState`] snapshot so the
// frontend team store can replace its state in one shot. Lifecycle changes
// also stream live on the `"team_event"` channel via the [`TeamBus`].

/// Reload the brain snapshot after a mutation.
fn snapshot(session: &TeamSession) -> Result<TeamProjectState, String> {
    session
        .workspace()
        .load_state(Some(DEFAULT_CHANNEL_TAIL))
        .map_err(|e| e.to_string())
}

/// Convene the team: seed the roster (Lead + clamped ICs) and enter the
/// Planning phase. `max_size` is the user's configured ceiling (the
/// frontend passes it from settings); it is clamped again to the hard
/// ceiling in the runtime.
#[tauri::command]
pub async fn team_convene(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    request: ConveneRequest,
    max_size: usize,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .convene(&bus, request, max_size)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Add one IC to the running team (rejected if it would exceed `max_size`).
#[tauri::command]
pub async fn team_add_agent(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent: AgentSpec,
    max_size: usize,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .add_agent(&bus, agent, max_size)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Remove/dismiss an IC; its scope is released and its tasks unassigned.
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

/// Stop the whole team run (soft stop → Disbanded; brain stays on disk).
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

/// Update one agent's live status (no channel post; reflected on read).
#[tauri::command]
pub async fn team_set_agent_status(
    repo_path: String,
    agent_id: String,
    status: AgentStatus,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .set_agent_status(&agent_id, status)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Authoritatively (re)assign folder ownership to an agent, keeping the
/// partition non-overlapping (§8).
#[tauri::command]
pub async fn team_assign_scope(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent_id: String,
    owned_paths: Vec<String>,
    owned_contracts: Option<Vec<String>>,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .assign_scope(
            &bus,
            &agent_id,
            owned_paths,
            owned_contracts.unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Push a ticket onto the board for an owner (or unassigned).
#[tauri::command]
pub async fn team_assign_task(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    title: String,
    owner: Option<String>,
    depends_on: Option<Vec<String>>,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .assign_task(&bus, title, owner, depends_on.unwrap_or_default())
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Update a task's status.
#[tauri::command]
pub async fn team_set_task_status(
    repo_path: String,
    task_id: String,
    status: TaskStatus,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .set_task_status(&task_id, status)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

// ─── Live planning round (Phase 2b) ───────────────────────────────────────

/// Run the live planning round: the Lead proposes a team + non-overlapping
/// scope partition + seeded board via real model calls, then each IC runs a
/// one-shot standup turn. Every step streams on the `"team_event"` channel
/// via the [`TeamBus`] as it happens; the returned snapshot is the settled
/// brain state.
///
/// `lead_provider_config` and `team_provider_config` are
/// [`crate::api::ProviderConfigSnapshot`]s resolved on the frontend from the
/// user's Agent → Team settings (`getTeamLeadConfig()` /
/// `getTeamMemberConfig()` → `buildProviderConfigSnapshot`). When the user
/// hasn't overridden either, both resolve to the active chat model, so the
/// team rides on the chat provider by default. When they differ, the Lead
/// and the IC team run on separate configured providers. Tauri exposes them
/// as `leadProviderConfig` / `teamProviderConfig` on the JS side.
#[tauri::command]
pub async fn team_run_planning(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    goal: String,
    lead_provider_config: crate::api::ProviderConfigSnapshot,
    team_provider_config: crate::api::ProviderConfigSnapshot,
    max_size: usize,
    desired_ics: Option<usize>,
) -> Result<TeamProjectState, String> {
    crate::agent_runtime::team::run_planning(
        &bus,
        &repo_path,
        &goal,
        &lead_provider_config,
        &team_provider_config,
        max_size,
        desired_ics,
    )
    .await
    .map_err(|e| e.to_string())
}

// ─── Parallel build + scope enforcement (Phase 3) ─────────────────────────
//
// These drive the build phase of the lifecycle (§9 step 3): flip the team
// into Building, enforce the scope partition on writes (§8), and carry the
// lateral coordination an in-scope build needs (boundary questions +
// published contracts). Each mutation returns a fresh snapshot; the
// read-only guard check returns just its decision.

/// Start the parallel build: move the team into the Building phase and flip
/// every scoped IC to `building` (§9). Rejected on a disbanded team.
#[tauri::command]
pub async fn team_begin_build(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session.begin_build(&bus).map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Run the full parallel build round: flip the team to Building, then drive
/// each scoped IC through a guarded tool-calling loop that edits **only** its
/// owned files in the real repo (§8/§9). Per-IC summaries + lifecycle events
/// stream live on `"team_event"`; the returned snapshot is the settled brain
/// (Integrating once every IC finishes).
///
/// `team_provider_config` is the [`crate::api::ProviderConfigSnapshot`] every
/// IC runs on (resolved on the frontend from Agent → Team `getTeamMemberConfig()`,
/// defaulting to the active chat model). Exposed as `teamProviderConfig` to JS.
#[tauri::command]
pub async fn team_run_build(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    goal: String,
    team_provider_config: crate::api::ProviderConfigSnapshot,
) -> Result<TeamProjectState, String> {
    crate::agent_runtime::team::run_build(&bus, &repo_path, &goal, &team_provider_config)
        .await
        .map_err(|e| e.to_string())
}

/// Ask the scope write-guard whether `agent_id` may write `path` against the
/// current ownership partition (§8). Read-only — no brain mutation, no
/// channel post. The build runner runs this before letting an IC's write
/// land; the team view uses it to explain a refused edit.
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

/// Raise a boundary question from one agent to a scope owner (§8). Persisted
/// + broadcast on the team channel as a `boundary_question`.
#[tauri::command]
pub async fn team_ask_boundary(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    from_agent: String,
    to_owner: String,
    question: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .ask_boundary(&bus, &from_agent, &to_owner, &question)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Publish a shared interface other agents can depend on (§8). Records it
/// under the author's `owned_contracts` and posts a `contract_published`.
#[tauri::command]
pub async fn team_publish_contract(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent_id: String,
    name: String,
    body: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .publish_contract(&bus, &agent_id, &name, &body)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Mark an IC finished. When every IC is done, the team closes and the Lead
/// gets the worker reports.
#[tauri::command]
pub async fn team_mark_agent_done(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    agent_id: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .mark_agent_done(&bus, &agent_id)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

// ── Phase 4: integration & peer review ─────────────────────────────────────

/// Record one agent's peer-review verdict on another's work (§9 step 5).
/// Persists a note under `integration/reviews/` and posts a `review_verdict`
/// to the channel. `verdict` is `"approve"` or `"changes_requested"`.
#[tauri::command]
pub async fn team_record_review(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    reviewer: String,
    target: String,
    verdict: ReviewVerdict,
    comments: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .record_review(&bus, &reviewer, &target, verdict, &comments)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Record the integration gate result to `integration/status.json` and post a
/// Lead summary (§9 step 5, §14). Each field is a `GateStatus`
/// (`unknown` / `pending` / `passed` / `failed`).
#[tauri::command]
pub async fn team_set_gate_status(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    build: GateStatus,
    lint: GateStatus,
    test: GateStatus,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .set_gate_status(&bus, build, lint, test)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Close the integration phase: move the team to `done` when no gate failed,
/// else keep it integrating (§14). Posts the Lead's wrap-up to the channel.
#[tauri::command]
pub async fn team_finish_integration(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
) -> Result<TeamProjectState, String> {
    let session = TeamSession::open(&repo_path).map_err(|e| e.to_string())?;
    session
        .finish_integration(&bus)
        .map_err(|e| e.to_string())?;
    snapshot(&session)
}

/// Run the full integration & peer-review gate (§9 step 5, §14): a round-robin
/// review pass (each scoped IC reviews a peer) followed by the build/lint/test
/// gate run in the real repo, then the Lead's finish. Review verdicts + gate
/// results + the wrap-up stream live on `"team_event"`; the returned snapshot
/// is the settled brain (`done` when the gate passes).
///
/// `team_provider_config` drives the review calls; `gate` carries the opt-in
/// shell commands (a missing command leaves that gate `unknown`).
#[tauri::command]
pub async fn team_run_integration(
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    team_provider_config: crate::api::ProviderConfigSnapshot,
    gate: Option<GateCommands>,
) -> Result<TeamProjectState, String> {
    let gate = gate.unwrap_or_default();
    crate::agent_runtime::team::run_integration(&bus, &repo_path, &team_provider_config, &gate)
        .await
        .map_err(|e| e.to_string())
}

// ── Background dispatch (the team is its own engine) ────────────────────────
//
// `team_dispatch` is the Lead's single non-blocking entry point: it hands the
// assigned worker run to the [`TeamDispatcher`], which runs it on a detached
// task and returns control to the Lead immediately. The Lead is then free to
// keep chatting; it learns the outcome via `team_run_status` (injected into its
// context every message). The phased commands above remain for tests/manual
// control.

/// Dispatch the assigned worker run in the background and return the current
/// (just-scaffolded) brain snapshot. Does NOT wait for the run — the team
/// works on its own engine while the Lead stays free (ground truth §17).
///
/// `desired_ics` and `gate` remain in the IPC shape for compatibility; assigned
/// `members` define the actual workers. Rejected if a run is already in
/// progress for this workspace.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_dispatch(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    bus: State<'_, Arc<TeamBus>>,
    repo_path: String,
    goal: String,
    members: Option<Vec<DispatchMember>>,
    lead_provider_config: crate::api::ProviderConfigSnapshot,
    team_provider_config: crate::api::ProviderConfigSnapshot,
    max_size: usize,
    desired_ics: Option<usize>,
    gate: Option<GateCommands>,
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
        desired_ics,
        gate.unwrap_or_default(),
        origin_thread_id,
        origin_surface,
    )?;

    ws.load_state(Some(DEFAULT_CHANNEL_TAIL))
        .map_err(|e| e.to_string())
}

/// Read the live background-run status for a workspace (`idle` / `running` +
/// phase / `done` / `failed`). The frontend injects this into the Lead's
/// context on every message so the Lead always knows where the team stands.
#[tauri::command]
pub async fn team_run_status(
    dispatcher: State<'_, Arc<TeamDispatcher>>,
    repo_path: String,
) -> Result<TeamRunStatus, String> {
    Ok(dispatcher.status(&project_id_for(&repo_path)))
}

/// Mark a terminal run's completion report as delivered to the Lead. The
/// dispatcher owns the flag, so delivery is exactly-once across window
/// reloads — the completion notifier acks before it submits the report turn,
/// and skips any run that is already acknowledged. Returns the fresh status.
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

// ── Per-agent transcript (the team-window's individual agent view) ──────────
//
// The team channel is the *group* chat; it deliberately doesn't carry an
// agent's tool calls/results. The per-agent view in the window needs exactly
// that — "what is Nina calling, and what is she getting back" — which lives in
// `agents/<id>/session.jsonl`, persisted live as the IC works. These DTOs are
// the display projection of that transcript.

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

/// Read one agent's transcript (`agents/<id>/session.jsonl`) as display turns —
/// what it called and what it got back. Empty until the agent starts building.
/// Safe to poll (the team window refreshes the selected agent on an interval).
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
                // Compaction markers carry no transcript-visible content (the
                // summary is model-only); the team transcript view skips them.
                ContentBlock::Compaction { .. } => {}
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
