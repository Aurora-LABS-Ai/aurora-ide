//! `run_build` — the **parallel build round** (ground truth §9 step 3,
//! §16 Phase 3 "the build runner").
//!
//! Phase 2b produced a locked, non-overlapping scope partition and a seeded
//! board. This module drives the actual build: it flips the team to
//! [`TeamPhase::Building`] and runs each scoped IC through a real
//! tool-calling model loop that edits files **inside its owned scope** — and
//! only there. Every file write is gated by the scope write-guard
//! ([`super::scope_guard`]); a write that lands outside the agent's scope is
//! refused and the model is told who owns the path so it can raise a boundary
//! question or depend on a published contract instead (§8).
//!
//! ## Where the model + tools come from
//!
//! Like [`super::runner`], this reuses Aurora's provider stack verbatim —
//! [`crate::api::build_api_client`] behind the [`StreamingApiClient`] trait —
//! and reuses the [`TeamSession`] control surface for every brain mutation
//! (status flips, contracts, boundary asks, done/roll-over). The IC tool
//! catalogue is the **same file/workspace tools the normal Aurora agent uses
//! to build a project**, limited to that bucket (no shell / browser / MCP /
//! todo) — see [`IC_CORE_TOOL_NAMES`], kept in lockstep with the refined
//! Rust registry roster (`tools::file_workspace_search::TOOL_NAMES`):
//! - read / inspect / research (unrestricted): `file_read` (single or batch),
//!   `workspace_tree`, `grep`, `auroro_websearch`.
//! - write / edit / scaffold (scope-guarded): `file_write`, `file_edit`,
//!   `move_path`, `delete_path`, `folder_create`.
//! - lateral coordination: `send_message`, `publish_contract`, `ask_owner`,
//!   `finish`. An `@lead` mention (or `ask_owner` to `lead`) reaches the LEAD,
//!   which answers as coordinator and can GRANT scope access on the spot.
//! Every write/edit/delete/folder op is gated by the scope write-guard; an
//! `@mention` in `send_message` and `ask_owner` both get a real, grounded reply
//! from the addressed teammate (answered from its actual files + contracts).
//!
//! ## Execution model — truly parallel
//!
//! Every scoped IC builds **concurrently**: `run_build` joins one future per
//! IC (`futures::future::join_all`), so all the model streams — the long
//! part of a build turn by orders of magnitude — are in flight at the same
//! time. That's the whole point of a team: N members working at once, each
//! transcript advancing live in the team window.
//!
//! Brain consistency needs no locks because the joined futures run on **one
//! task**: cooperative scheduling means execution only interleaves at
//! `.await` points, and every read-modify-write of a brain document
//! (`team.json`, `tasks.json`, `events.jsonl`, …) is synchronous code
//! between awaits — it always runs to completion before another IC's future
//! resumes. The scope partition (§8) keeps their *repo* writes disjoint.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_runtime::api_client::{ApiRequest, StreamingApiClient, ToolSchema};
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::tool_executor::{ToolContext, ToolRegistry};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};
use crate::api::{build_api_client, ProviderConfigSnapshot};
use crate::tools::shell_editor_todo::NoopIdeEventSink;

use super::bus::{TeamBus, TeamStreamer};
use super::orchestrator::{TeamSession, LEAD_AGENT_ID};
use super::runner::{complete_text, resolved_max_tokens, TEAM_MODEL_CALL_TIMEOUT};
use super::scope_guard;
use super::types::{
    AgentRecord, AgentStatus, ChannelEvent, ChannelEventKind, ScopeMap, TaskStatus,
    TeamProjectState,
};
use super::workspace::{now_rfc3339, DEFAULT_CHANNEL_TAIL};

/// Max tool-call round-trips per IC before we force the turn to wrap. Generous
/// so an IC can write many owned files (one `write_file` per turn is fine).
const MAX_BUILD_ITERATIONS: usize = 16;
/// How many times we'll nudge a model that produced a turn with **no tool
/// calls** (all thinking/prose) before giving up. Reasoning models routinely
/// think-then-stop; a nudge gets them to actually call `write_file` instead of
/// the build silently ending with nothing written.
const MAX_IDLE_NUDGES: usize = 3;
/// The IC's file/workspace tool catalogue — the **same tools the normal Aurora
/// agent uses to build a project**, just limited to the read / inspect / write /
/// edit file bucket (no shell, browser, MCP, or todo). Reads are unrestricted;
/// every write/edit/move/delete/folder op is scope-guarded so an IC can only
/// mutate inside its owned paths. Kept in lockstep with the Rust registry
/// roster (`tools::file_workspace_search::TOOL_NAMES`) — a name listed here
/// that the registry doesn't have would be silently dropped from the schema
/// (and burn IC turns as "unknown tool" when a model calls it anyway).
const IC_CORE_TOOL_NAMES: &[&str] = &[
    // read / inspect / research (unrestricted)
    "file_read",
    "workspace_tree",
    "grep",
    "auroro_websearch",
    // write / edit / scaffold (scope-guarded)
    "file_write",
    "file_edit",
    "move_path",
    "delete_path",
    "folder_create",
];

// ─── public entry point ───────────────────────────────────────────────────

/// Run the parallel build round for a repo and return the settled brain
/// snapshot. Flips the team to Building, then drives each scoped IC through a
/// guarded tool loop on `team_provider`. Lifecycle + per-IC summaries stream
/// live on the `"team_event"` channel as they happen.
///
/// `repo_path` is the **user's real repository** (where files are written);
/// the brain lives separately under `~/.aurora/projects/<id>/`.
pub async fn run_build(
    bus: &TeamBus,
    repo_path: &str,
    goal: &str,
    team_provider: &ProviderConfigSnapshot,
) -> Result<TeamProjectState, RuntimeError> {
    let session = TeamSession::open(repo_path)?;
    let client = build_api_client(team_provider);
    let model = team_provider.model.clone();
    // Output budget comes from the user's model settings (`default_max_tokens`),
    // never a hardcode — reasoning models need the full configured headroom to
    // think AND emit complete file contents in `write_file`.
    let max_tokens = resolved_max_tokens(team_provider);
    run_build_inner(
        bus,
        &session,
        Path::new(repo_path),
        &client,
        &model,
        max_tokens,
        goal,
    )
    .await?;
    session.workspace().load_state(Some(DEFAULT_CHANNEL_TAIL))
}

/// Testable core: drive the build over an already-opened session with an
/// injected client. `run_build` is the thin production wrapper.
#[allow(clippy::too_many_arguments)]
async fn run_build_inner(
    bus: &TeamBus,
    session: &TeamSession,
    repo_root: &Path,
    client: &Arc<dyn StreamingApiClient>,
    model: &str,
    max_tokens: u32,
    goal: &str,
) -> Result<(), RuntimeError> {
    // 1. Flip the team into Building (scoped ICs → building, others idle).
    session.begin_build(bus)?;

    let team = session
        .workspace()
        .read_team()?
        .ok_or_else(|| RuntimeError::InvalidState("team.json missing; convene first".into()))?;
    let scope = session
        .workspace()
        .read_scope_map()?
        .unwrap_or_else(|| ScopeMap::empty(now_rfc3339()));

    // Collect the scoped ICs — they ALL build concurrently below. Unscoped ICs
    // have nothing to own and are skipped (left idle by begin_build).
    let scoped_ics: Vec<AgentRecord> = team
        .agents
        .iter()
        .filter(|a| a.id != LEAD_AGENT_ID)
        .filter(|a| owned_paths_of(&scope, &a.id).is_some_and(|p| !p.is_empty()))
        .cloned()
        .collect();

    // Roster id→role, so a building IC can address a boundary question to the
    // right owner and the owner can answer in character (synchronous ask_owner).
    let roster: Vec<(String, String)> = team
        .agents
        .iter()
        .map(|a| (a.id.clone(), a.role.clone()))
        .collect();

    // Drive every scoped IC **at the same time**. Each IC gets its own future
    // (model loop + completion bookkeeping); `join_all` keeps all their model
    // streams in flight concurrently while the single-task scheduling keeps
    // every synchronous brain mutation atomic (see module docs).
    let cancel = CancellationToken::new();
    let ic_futures = scoped_ics.iter().map(|rec| {
        let owned = owned_paths_of(&scope, &rec.id).unwrap_or_default();
        let tasks = ic_task_titles(session, &rec.id).unwrap_or_default();
        let roster = roster.clone();
        let cancel = cancel.clone();
        async move {
            let outcome = build_one_ic(
                bus, session, repo_root, client, model, max_tokens, &cancel, goal, rec, &owned,
                &tasks, &roster,
            )
            .await
            // A single IC failing must not abort the whole build immediately:
            // record it, let peers finish, then fail the build as a whole.
            .unwrap_or_else(|e| {
                BuildOutcome::failed(&rec.id, &rec.role, format!("build turn errored: {e}"))
            });

            // Post the IC's build summary to the channel, then mark it done.
            // Only verified builders are marked Done; failed builders stay
            // Blocked so the team cannot report done.
            bus.post(
                session.workspace(),
                ChannelEvent {
                    id: Uuid::new_v4().to_string(),
                    ts: now_rfc3339(),
                    author: rec.id.clone(),
                    kind: ChannelEventKind::Message,
                    body: outcome.summary.clone(),
                    meta: Some(json!({ "phase": "building", "role": rec.role })),
                },
            )?;
            if outcome.is_success() {
                session.mark_agent_done(bus, &rec.id)?;

                // Reflect completion on the board so the gate/status shows real
                // progress (otherwise tickets sit at "todo" forever and the
                // UI/Lead report a misleading 0/N done after the team finished).
                if let Ok(Some(mut board)) = session.workspace().read_tasks() {
                    let mut changed = false;
                    for t in &mut board.tasks {
                        if t.owner.as_deref() == Some(rec.id.as_str())
                            && !matches!(t.status, TaskStatus::Done)
                        {
                            t.status = TaskStatus::Done;
                            changed = true;
                        }
                    }
                    if changed {
                        board.updated_at = now_rfc3339();
                        let _ = session.workspace().write_tasks(&board);
                    }
                }
            } else {
                session.set_agent_status(&rec.id, AgentStatus::Blocked)?;
            }
            Ok::<BuildOutcome, RuntimeError>(outcome)
        }
    });

    // Wait for the WHOLE team. Every IC future runs to completion regardless
    // of peers failing; surface the first brain-level error (disk/IO) only
    // after everyone finished, so one broken member never strands the rest.
    let outcomes = futures::future::join_all(ic_futures).await;
    let mut build_outcomes = Vec::with_capacity(outcomes.len());
    for outcome in outcomes {
        build_outcomes.push(outcome?);
    }
    if let Some(reason) = build_failure_message(&build_outcomes) {
        return Err(RuntimeError::InvalidState(reason));
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct BuildOutcome {
    agent_id: String,
    role: String,
    summary: String,
    changed: Vec<String>,
    blocking_errors: Vec<String>,
}

impl BuildOutcome {
    fn from_exec(rec: &AgentRecord, exec: &BuildTools<'_>) -> Self {
        Self {
            agent_id: rec.id.clone(),
            role: rec.role.clone(),
            summary: exec.summary(),
            changed: exec.changed.clone(),
            blocking_errors: exec.blocking_errors.clone(),
        }
    }

    fn failed(agent_id: &str, role: &str, reason: String) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            role: role.to_string(),
            summary: format!("Build failed: {reason}"),
            changed: Vec::new(),
            blocking_errors: vec![compact_tool_error(&reason)],
        }
    }

    /// A member succeeded if it produced real deliverables. A leftover
    /// scope rejection (only ever a *peer*-owned path now — unassigned ground
    /// is allowed) is a coordination note, NOT a run-killer: it must not throw
    /// away the files this member actually wrote, nor fail the whole team. A
    /// member that changed nothing is the genuine failure.
    fn is_success(&self) -> bool {
        !self.changed.is_empty()
    }
}

fn build_failure_message(outcomes: &[BuildOutcome]) -> Option<String> {
    if outcomes.is_empty() {
        return Some("no scoped IC builders were available; nothing was built".to_string());
    }
    let failed: Vec<&BuildOutcome> = outcomes.iter().filter(|o| !o.is_success()).collect();
    if failed.is_empty() {
        return None;
    }
    let details: Vec<String> = failed
        .iter()
        .map(|o| {
            if o.blocking_errors.is_empty() {
                format!(
                    "{} ({}): no changed files in assigned scope",
                    o.agent_id, o.role
                )
            } else {
                format!(
                    "{} ({}): {}",
                    o.agent_id,
                    o.role,
                    o.blocking_errors.join(" | ")
                )
            }
        })
        .collect();
    Some(format!(
        "{} scoped IC(s) completed with no changed files/effective writes: {}",
        failed.len(),
        details.join("; ")
    ))
}

/// Run one IC's guarded build turn and return a human-readable summary of
/// what it changed (for the channel).
#[allow(clippy::too_many_arguments)]
async fn build_one_ic(
    bus: &TeamBus,
    session: &TeamSession,
    repo_root: &Path,
    client: &Arc<dyn StreamingApiClient>,
    model: &str,
    max_tokens: u32,
    cancel: &CancellationToken,
    goal: &str,
    rec: &AgentRecord,
    owned: &[String],
    tasks: &[String],
    roster: &[(String, String)],
) -> Result<BuildOutcome, RuntimeError> {
    let system = ic_build_prompt(&rec.role, owned, tasks);
    // Inject the shared brain so this IC builds AWARE of the team — the
    // ownership partition, the contracts peers have already published (with
    // their bodies), and the recent group chat. This is what makes the team a
    // real team and not blind sub-agents: a later IC sees and depends on an
    // earlier one's work instead of guessing.
    let team_context = build_team_context(session, &rec.id);
    let mut messages = vec![ConversationMessage::user_text(
        format!(
            "Overall goal:\n{goal}\n\n=== TEAM CONTEXT (read this) ===\n{team_context}\n=== END TEAM CONTEXT ===\n\nBuild your scope now. Read what you need (anywhere), write real files inside your owned paths, and coordinate with `send_message` / `ask_owner` / `publish_contract`. When done, call `finish`."
        ),
        Utc::now().timestamp_millis(),
    )];

    let tools = ic_build_tools();
    let mut exec = BuildTools::new(
        session,
        bus,
        repo_root.to_path_buf(),
        rec.id.clone(),
        client,
        model.to_string(),
        max_tokens,
        cancel.clone(),
        roster.to_vec(),
    );

    // Everything already in the channel is covered by the initial team
    // context; from here on we only surface what's NEW between turns.
    let mut seen_events = session
        .workspace()
        .read_channel(None)
        .map(|v| v.len())
        .unwrap_or(0);

    // One live streamer for this IC's whole build: each turn brackets its
    // tokens with start/end so the per-agent transcript streams in real time.
    let project_id = session.workspace().project_id().to_string();
    let streamer = TeamStreamer::new(bus, project_id, rec.id.clone(), "building", None);

    let mut idle_nudges = 0usize;
    for _ in 0..MAX_BUILD_ITERATIONS {
        // Live team awareness: peers build in PARALLEL, so contracts and chat
        // they post mid-run land after this IC's initial context snapshot.
        // Surface anything new (from others) before each model turn so a
        // teammate's just-published contract can be depended on immediately.
        if let Ok(events) = session.workspace().read_channel(None) {
            if events.len() > seen_events {
                let fresh: Vec<String> = events[seen_events..]
                    .iter()
                    .filter(|e| e.author != rec.id)
                    .filter(|e| {
                        matches!(
                            e.kind,
                            ChannelEventKind::Message
                                | ChannelEventKind::BoundaryQuestion
                                | ChannelEventKind::ContractPublished
                        )
                    })
                    // ask_owner answers addressed to us already arrived in the
                    // tool result — don't deliver them twice.
                    .filter(|e| {
                        e.meta
                            .as_ref()
                            .and_then(|m| m.get("answerTo"))
                            .and_then(|v| v.as_str())
                            != Some(rec.id.as_str())
                    })
                    .map(|e| format!("{}: {}", e.author, e.body.trim()))
                    .collect();
                seen_events = events.len();
                if !fresh.is_empty() {
                    messages.push(ConversationMessage::user_text(
                        format!(
                            "=== LIVE TEAM UPDATE (your teammates, working in parallel) ===\n{}\n=== END UPDATE ===",
                            fresh.join("\n")
                        ),
                        Utc::now().timestamp_millis(),
                    ));
                }
            }
        }

        let turn = complete_turn(
            client,
            model,
            max_tokens,
            &system,
            &messages,
            &tools,
            cancel,
            Some(&streamer),
        )
        .await?;
        messages.push(turn.assistant_message.clone());
        // Persist live so the per-agent transcript in the team window shows
        // what this IC is calling the moment it calls it (not only at the end).
        persist_session(session, &rec.id, &messages);

        let calls: Vec<(String, String, serde_json::Value)> = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
            .collect();

        if calls.is_empty() {
            // No tool calls this turn. With reasoning models this is the common
            // failure mode: the turn is all `thinking` (or prose describing the
            // files) and ends — often truncated — before any `write_file` lands.
            // Treating that as "done" is exactly what made ICs report
            // "no files changed". Instead, nudge the model to ACTUALLY write,
            // up to a few times, before giving up.
            if exec.finished {
                break;
            }
            idle_nudges += 1;
            if idle_nudges > MAX_IDLE_NUDGES {
                break;
            }
            messages.push(ConversationMessage::user_text(
                "You haven't written any files yet — you only described or thought about the work. Call the write_file tool NOW to create each file in your scope (one write_file call per file is fine, and you have several turns). Do NOT put file contents in prose or thinking; you must actually call write_file. When every owned file is written, call finish."
                    .to_string(),
                Utc::now().timestamp_millis(),
            ));
            continue;
        }
        idle_nudges = 0;

        let mut results = Vec::with_capacity(calls.len());
        for (id, name, input) in &calls {
            let (content, is_error) = exec.execute(id, name, input).await?;
            results.push(ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content,
                is_error: Some(is_error),
            });
        }
        // CRITICAL: tool results must be a `Tool`-role message, not `User`.
        // The OpenAI-compat request converter only emits `{role:"tool",
        // tool_call_id, content}` entries for `MessageRole::Tool`; for `User`
        // it runs `collect_text`, which sees only Text blocks — so a User
        // message carrying only ToolResult blocks serializes to
        // `{"role":"user","content":""}` and the file contents are DROPPED
        // before they reach the model. That's exactly why ICs kept reasoning
        // "the files seem to be empty" and re-reading: they never received the
        // read_file output. Tagging the message `Tool` delivers it correctly.
        messages.push(ConversationMessage {
            role: MessageRole::Tool,
            blocks: results,
            usage: None,
            timestamp: Utc::now().timestamp_millis(),
            attached_selected_elements: None,
            attached_prompt_chips: None,
        });
        // Persist again so the tool RESULTS (what the agent "got back") show up
        // live in the per-agent transcript right after the calls.
        persist_session(session, &rec.id, &messages);

        if exec.finished {
            break;
        }
    }

    // Final persist (covers the nudge/iteration-cap break paths) so the full
    // transcript is on disk for audit/resume (§6/§15).
    persist_session(session, &rec.id, &messages);

    Ok(BuildOutcome::from_exec(rec, &exec))
}

/// Render the shared brain into a context block for a building IC: the
/// ownership partition, every published contract (name + body), and the recent
/// team chat. This is the wiring that makes peers actually depend on each other.
fn build_team_context(session: &TeamSession, me: &str) -> String {
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
            parts.push(format!(
                "Ownership map (you may write ONLY inside your own paths):\n{}",
                lines.join("\n")
            ));
        }
    }

    if let Ok(contracts) = ws.read_contracts() {
        if !contracts.is_empty() {
            let rendered: Vec<String> = contracts
                .iter()
                .map(|(_n, b)| b.trim().to_string())
                .collect();
            parts.push(format!(
                "Published contracts you may depend on (do NOT edit the owner's files — use these):\n{}",
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
                        | ChannelEventKind::ReviewVerdict
                )
            })
            .map(|e| format!("{}: {}", e.author, e.body.trim()))
            .collect();
        if !lines.is_empty() {
            parts.push(format!("Recent team chat:\n{}", lines.join("\n")));
        }
    }

    if parts.is_empty() {
        "(no team context yet — you're first to build)".to_string()
    } else {
        parts.join("\n\n")
    }
}

// ─── tool execution ───────────────────────────────────────────────────────

/// Per-IC tool executor: resolves paths against the real repo root, enforces
/// the scope write-guard on every write, and routes lateral tools
/// (`publish_contract`, `ask_owner`) through the [`TeamSession`].
struct BuildTools<'a> {
    session: &'a TeamSession,
    bus: &'a TeamBus,
    repo_root: PathBuf,
    agent_id: String,
    /// Client/model/budget/cancel for synchronous peer consultation
    /// (`ask_owner`). The budget comes from the user's model settings.
    client: &'a Arc<dyn StreamingApiClient>,
    model: String,
    max_tokens: u32,
    cancel: CancellationToken,
    /// Roster (id, role) so a boundary question can be answered in character
    /// by the actual owner.
    roster: Vec<(String, String)>,
    core_tools: Arc<ToolRegistry>,
    changed: Vec<String>,
    blocking_errors: Vec<String>,
    finished: bool,
    finish_note: Option<String>,
}

impl<'a> BuildTools<'a> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        session: &'a TeamSession,
        bus: &'a TeamBus,
        repo_root: PathBuf,
        agent_id: String,
        client: &'a Arc<dyn StreamingApiClient>,
        model: String,
        max_tokens: u32,
        cancel: CancellationToken,
        roster: Vec<(String, String)>,
    ) -> Self {
        Self {
            session,
            bus,
            repo_root,
            agent_id,
            client,
            model,
            max_tokens,
            cancel,
            roster,
            core_tools: Arc::new(ic_core_registry()),
            changed: Vec::new(),
            blocking_errors: Vec::new(),
            finished: false,
            finish_note: None,
        }
    }

    /// Dispatch one tool call. Returns `(content, is_error)` for the
    /// tool-result block. A `RuntimeError` is only returned for a brain-level
    /// failure (disk/IO on the brain itself); tool-level problems (bad path,
    /// scope denial, missing file) come back as `is_error = true` content so
    /// the model can recover within the turn.
    async fn execute(
        &mut self,
        tool_call_id: &str,
        name: &str,
        input: &serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let result = match name {
            "file_read" | "workspace_tree" | "grep" | "auroro_websearch" => {
                self.execute_core_tool(tool_call_id, name, input.clone())
                    .await
            }
            "file_write" | "file_edit" | "delete_path" | "folder_create" => {
                self.execute_guarded_core_tool(tool_call_id, name, input.clone())
                    .await
            }
            // move_path touches TWO paths (source vanishes, destination
            // appears) — both must be inside this IC's scope.
            "move_path" => self.execute_move_path(tool_call_id, input.clone()).await,
            // Backward-compatible aliases: names from before the Rust file
            // toolset was refined 16→10 (and older team prompts). A model
            // replaying a stale transcript still lands on the real executor
            // instead of "unknown tool".
            "read_file" | "multi_file_read" | "file_exists" => {
                self.execute_core_tool(tool_call_id, "file_read", input.clone())
                    .await
            }
            "list_dir" => Ok(self.list_dir(input)),
            "search_text" => {
                self.execute_core_tool(tool_call_id, "grep", search_text_to_grep(input))
                    .await
            }
            "write_file" | "file_create" => {
                self.execute_guarded_core_tool(tool_call_id, "file_write", input.clone())
                    .await
            }
            "search_replace" | "multi_search_replace" => {
                self.execute_guarded_core_tool(tool_call_id, "file_edit", input.clone())
                    .await
            }
            "delete_file" | "file_delete" => {
                self.execute_guarded_core_tool(tool_call_id, "delete_path", input.clone())
                    .await
            }
            "folder_delete" => {
                // delete_path needs recursive=true to remove a folder.
                let mut folder_input = input.clone();
                if let Some(obj) = folder_input.as_object_mut() {
                    obj.insert("recursive".into(), serde_json::Value::Bool(true));
                }
                self.execute_guarded_core_tool(tool_call_id, "delete_path", folder_input)
                    .await
            }
            "send_message" => self.send_message(input).await,
            "publish_contract" => self.publish_contract(input),
            "ask_owner" => self.ask_owner(input).await,
            "finish" => Ok(self.finish(input)),
            other => Ok((format!("unknown tool '{other}'"), true)),
        };
        if let Ok((content, true)) = &result {
            if is_blocking_tool_error(content) {
                let compact = compact_tool_error(content);
                if !self.blocking_errors.iter().any(|e| e == &compact) {
                    self.blocking_errors.push(compact);
                }
            }
        }
        result
    }

    async fn execute_core_tool(
        &self,
        tool_call_id: &str,
        name: &str,
        input: serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let Some(tool) = self.core_tools.get(name) else {
            return Ok((format!("unknown tool '{name}'"), true));
        };
        let ctx = ToolContext {
            turn_id: format!("team-{}", self.agent_id),
            tool_call_id: tool_call_id.to_string(),
            session_id: self.agent_id.clone(),
            workspace_root: Some(self.repo_root.clone()),
            allow_outside_workspace: false,
            cancel_token: self.cancel.clone(),
        };
        match tool.execute(input, &ctx).await {
            Ok(content) => Ok((content, false)),
            Err(err) => Ok((err.to_string(), true)),
        }
    }

    async fn execute_guarded_core_tool(
        &mut self,
        tool_call_id: &str,
        name: &str,
        input: serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let Some(rel) = input.get("path").and_then(|v| v.as_str()) else {
            return Ok((format!("{name} requires a 'path' argument"), true));
        };
        let decision = self.session.check_write(&self.agent_id, rel)?;
        if !decision.allowed {
            return Ok((
                format!("{}: {}", rejection_prefix(name), decision.reason),
                true,
            ));
        }

        let before = resolve_in_repo(&self.repo_root, &decision.path)
            .map(|p| path_fingerprint(&p))
            .unwrap_or(PathFingerprint::Missing);
        let (content, is_error) = self.execute_core_tool(tool_call_id, name, input).await?;
        let after = resolve_in_repo(&self.repo_root, &decision.path)
            .map(|p| path_fingerprint(&p))
            .unwrap_or(PathFingerprint::Missing);
        if !is_error
            && tool_result_success(&content)
            && before != after
            && !self.changed.iter().any(|c| c == &decision.path)
        {
            let label = if name == "delete_path" {
                format!("{} (deleted)", decision.path)
            } else {
                decision.path.clone()
            };
            self.changed.push(label);
        }
        Ok((content, is_error))
    }

    /// `move_path` guard: a move mutates BOTH ends — the source disappears and
    /// the destination appears — so each must be inside this IC's scope before
    /// the core tool runs.
    async fn execute_move_path(
        &mut self,
        tool_call_id: &str,
        input: serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let (Some(old_rel), Some(new_rel)) =
            (str_arg(&input, "old_path"), str_arg(&input, "new_path"))
        else {
            return Ok((
                "move_path requires 'old_path' and 'new_path' arguments".into(),
                true,
            ));
        };
        for rel in [&old_rel, &new_rel] {
            let decision = self.session.check_write(&self.agent_id, rel)?;
            if !decision.allowed {
                return Ok((format!("MOVE REJECTED: {}", decision.reason), true));
            }
        }
        let (content, is_error) = self
            .execute_core_tool(tool_call_id, "move_path", input)
            .await?;
        if !is_error && tool_result_success(&content) {
            for rel in [old_rel, new_rel] {
                if let Some(norm) = scope_guard::normalize_repo_rel(&rel) {
                    if !self.changed.iter().any(|c| c == &norm) {
                        self.changed.push(norm);
                    }
                }
            }
        }
        Ok((content, is_error))
    }

    fn finish(&mut self, input: &serde_json::Value) -> (String, bool) {
        if self.changed.is_empty() {
            return (
                "finish rejected: no owned files changed; write real deliverables inside your assigned scope before finishing".into(),
                true,
            );
        }
        // A leftover blocking error here is a *peer*-owned write the member
        // couldn't make (unassigned ground is allowed now). Looping won't fix
        // it — the owner makes that change. Let the member finish its own work;
        // the rejection is reported in the summary for coordination, not a hard
        // gate that strands the member.
        self.finished = true;
        self.finish_note = str_arg(input, "summary");
        ("Build turn marked complete.".to_string(), false)
    }

    fn list_dir(&self, input: &serde_json::Value) -> (String, bool) {
        let rel = str_arg(input, "path").unwrap_or_else(|| ".".to_string());
        let full = if rel == "." {
            self.repo_root.clone()
        } else {
            match resolve_in_repo(&self.repo_root, &rel) {
                Some(p) => p,
                None => return (format!("'{rel}' is not a valid repo-relative path"), true),
            }
        };
        match std::fs::read_dir(&full) {
            Ok(entries) => {
                let mut names: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        if e.path().is_dir() {
                            format!("{n}/")
                        } else {
                            n
                        }
                    })
                    .collect();
                names.sort();
                if names.is_empty() {
                    ("(empty directory)".to_string(), false)
                } else {
                    (names.join("\n"), false)
                }
            }
            Err(e) => (format!("could not list '{rel}': {e}"), true),
        }
    }

    /// Post a conversational line to the team group chat (§7). This is how an
    /// IC "talks" to the Lead and peers while it works — status, intent,
    /// questions phrased loosely — distinct from the structured lateral tools
    /// (`publish_contract` / `ask_owner`). Persisted + broadcast via the bus.
    async fn send_message(
        &mut self,
        input: &serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let Some(text) = str_arg(input, "text") else {
            return Ok(("send_message requires a 'text' argument".into(), true));
        };
        if text.trim().is_empty() {
            return Ok(("send_message 'text' must not be empty".into(), true));
        }
        self.bus.post(
            self.session.workspace(),
            ChannelEvent {
                id: Uuid::new_v4().to_string(),
                ts: now_rfc3339(),
                author: self.agent_id.clone(),
                kind: ChannelEventKind::Message,
                body: text.clone(),
                meta: Some(json!({ "phase": "building", "chat": true })),
            },
        )?;

        // Directed question? If this message @mentions teammate ids, each one
        // answers RIGHT NOW — grounded in their real files — and the replies
        // come back in THIS tool result. Without this, "@ui-owner what's the
        // prop name?" would just sit in the channel and the asker would move on
        // unanswered (the old void bug): a peer only re-reads the channel if it
        // happens to still be looping, and never once it has finished.
        let mentioned = self.mentioned_teammates(&text);
        if mentioned.is_empty() {
            return Ok(("Message posted to the team chat.".into(), false));
        }
        let mut replies = Vec::new();
        for to in mentioned {
            let answer = self.owner_answer(&to, &text).await;
            let _ = self.bus.post(
                self.session.workspace(),
                ChannelEvent {
                    id: Uuid::new_v4().to_string(),
                    ts: now_rfc3339(),
                    author: to.clone(),
                    kind: ChannelEventKind::Message,
                    body: answer.clone(),
                    meta: Some(
                        json!({ "phase": "building", "chat": true, "answerTo": self.agent_id }),
                    ),
                },
            );
            replies.push(format!("{to} replied: {answer}"));
        }
        Ok((replies.join("\n\n"), false))
    }

    /// Roster ids (excluding self) this message `@mentions`. Matches `@<id>`
    /// case-insensitively anywhere in the text so the model can address a
    /// teammate naturally.
    fn mentioned_teammates(&self, text: &str) -> Vec<String> {
        let lower = text.to_lowercase();
        self.roster
            .iter()
            .map(|(id, _)| id)
            .filter(|id| id.as_str() != self.agent_id)
            .filter(|id| lower.contains(&format!("@{}", id.to_lowercase())))
            .cloned()
            .collect()
    }

    fn publish_contract(
        &mut self,
        input: &serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let (Some(name), Some(body)) = (str_arg(input, "name"), str_arg(input, "body")) else {
            return Ok(("publish_contract requires 'name' and 'body'".into(), true));
        };
        self.session
            .publish_contract(self.bus, &self.agent_id, &name, &body)?;
        Ok((format!("Published contract '{name}'."), false))
    }

    /// Raise a boundary question to a scope owner AND get a real answer back.
    /// The question is posted to the channel (lateral + visible), then the owner
    /// answers **in character** via a one-shot model call; its answer is posted
    /// as the owner and returned to the asker. This is what makes "ask a peer
    /// and await the answer" (§7/§8) actually true instead of a message into a
    /// void.
    async fn ask_owner(
        &mut self,
        input: &serde_json::Value,
    ) -> Result<(String, bool), RuntimeError> {
        let (Some(to), Some(question)) = (str_arg(input, "to"), str_arg(input, "question")) else {
            return Ok((
                "ask_owner requires 'to' (agent id) and 'question'".into(),
                true,
            ));
        };
        if let Err(e) = self
            .session
            .ask_boundary(self.bus, &self.agent_id, &to, &question)
        {
            return Ok((format!("could not ask {to}: {e}"), true));
        }

        let answer = self.owner_answer(&to, &question).await;
        // Post the owner's reply to the group chat as the owner.
        let _ = self.bus.post(
            self.session.workspace(),
            ChannelEvent {
                id: Uuid::new_v4().to_string(),
                ts: now_rfc3339(),
                author: to.clone(),
                kind: ChannelEventKind::Message,
                body: answer.clone(),
                meta: Some(json!({ "phase": "building", "answerTo": self.agent_id })),
            },
        );

        Ok((format!("{to} replied: {answer}"), false))
    }

    /// Produce the LEAD's reply to a member's question, blocker, or access
    /// request (an `@lead` mention in `send_message`, or `ask_owner` with
    /// to="lead"). The Lead answers as the team's coordinator — grounded in
    /// the ownership map and recent chat — and can GRANT the asker write
    /// access on the spot: a final `GRANT: <path>[, <path>...]` line in its
    /// reply is applied to the scope map (authoritative reassign, the
    /// non-overlap invariant is preserved) and replaced with a human note.
    async fn lead_answer(&self, question: &str) -> String {
        let ws = self.session.workspace();
        let scope_lines = ws
            .read_scope_map()
            .ok()
            .flatten()
            .map(|s| {
                s.assignments
                    .iter()
                    .map(|a| {
                        let owned = if a.owned_paths.is_empty() {
                            "(none)".to_string()
                        } else {
                            a.owned_paths.join(", ")
                        };
                        format!("- {}: {}", a.agent_id, owned)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| "(no scope map yet)".to_string());
        let chat = ws
            .read_channel(Some(12))
            .map(|events| {
                events
                    .iter()
                    .map(|e| format!("{}: {}", e.author, e.body.trim()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        // The assignments the Lead handed out at dispatch (the board) — so a
        // member's question is answered against what was actually asked of
        // each member, not just the path map.
        let assignments = ws
            .read_tasks()
            .ok()
            .flatten()
            .map(|b| {
                b.tasks
                    .iter()
                    .map(|t| {
                        format!(
                            "- {}: {}",
                            t.owner.as_deref().unwrap_or("(unassigned)"),
                            t.title
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "(no assignments recorded)".to_string());

        let sys = "You are the LEAD engineer coordinating an autonomous AI engineering team inside the Aurora IDE. \
                   A team member has a question, blocker, or access request. Answer concretely in 1-3 sentences, as their coordinator. Do not write code.\n\n\
                   Access requests: writes to UNOWNED paths are already allowed — say so. If the path is owned by ANOTHER member, \
                   either tell the asker to coordinate through ask_owner / a published contract, or — when transferring ownership is clearly the right call — \
                   grant it by ending your reply with one line of EXACTLY this form:\n\
                   GRANT: <path>[, <path>...]\n\
                   That line transfers those paths to the asker and is stripped from your visible reply. \
                   Only grant paths whose transfer will not break the current owner's in-flight work."
            .to_string();
        let user = format!(
            "Assignments you gave each member:\n{assignments}\n\nCurrent ownership map:\n{scope_lines}\n\nRecent team chat:\n{chat}\n\nMessage from {} (their agent id):\n{question}",
            self.agent_id
        );
        let raw = complete_text(
            self.client,
            &self.model,
            &sys,
            &user,
            self.max_tokens,
            &self.cancel,
            None,
        )
        .await
        .unwrap_or_else(|e| format!("(the Lead could not answer — {e})"));
        self.apply_lead_grants(&raw)
    }

    /// Apply `GRANT: a, b` directive lines from a Lead reply: extend the
    /// asker's scope with the granted paths (assign_scope strips them from any
    /// peer, keeping the partition non-overlapping) and swap the directive for
    /// a human-readable note.
    fn apply_lead_grants(&self, reply: &str) -> String {
        let mut granted: Vec<String> = Vec::new();
        let mut visible: Vec<&str> = Vec::new();
        for line in reply.lines() {
            if let Some(rest) = line.trim().strip_prefix("GRANT:") {
                for p in rest.split(',') {
                    if let Some(norm) = scope_guard::normalize_repo_rel(p.trim()) {
                        if !norm.is_empty() && !granted.contains(&norm) {
                            granted.push(norm);
                        }
                    }
                }
            } else {
                visible.push(line);
            }
        }
        if granted.is_empty() {
            return reply.to_string();
        }

        let (mut paths, contracts) = self
            .session
            .workspace()
            .read_scope_map()
            .ok()
            .flatten()
            .and_then(|s| {
                s.assignments
                    .into_iter()
                    .find(|a| a.agent_id == self.agent_id)
                    .map(|a| (a.owned_paths, a.owned_contracts))
            })
            .unwrap_or_default();
        for p in &granted {
            if !paths.contains(p) {
                paths.push(p.clone());
            }
        }
        let applied = self
            .session
            .assign_scope(self.bus, &self.agent_id, paths, contracts)
            .is_ok();

        let mut out = visible.join("\n").trim().to_string();
        if applied {
            out.push_str(&format!(
                "\n\n(Access granted: {} — now inside your scope.)",
                granted.join(", ")
            ));
        } else {
            out.push_str(
                "\n\n(The grant could not be applied — ask again, or work through ask_owner.)",
            );
        }
        out
    }

    /// Produce a real answer from teammate `to` to `question`, in character and
    /// **grounded in that owner's actual work** — its published contracts and
    /// excerpts of the files it owns — not a blind role-play guess. Before this,
    /// the owner answered from only its role + path list, so it could
    /// confidently invent a signature for code it never wrote. Shared by
    /// `ask_owner` and an `@mention` in `send_message`. A question addressed to
    /// the LEAD routes to [`Self::lead_answer`] (coordinator persona + grants).
    async fn owner_answer(&self, to: &str, question: &str) -> String {
        if to == LEAD_AGENT_ID {
            return self.lead_answer(question).await;
        }
        let owner_role = self
            .roster
            .iter()
            .find(|(id, _)| id == to)
            .map(|(_, role)| role.clone())
            .unwrap_or_else(|| to.to_string());
        let owned_paths: Vec<String> = self
            .session
            .workspace()
            .read_scope_map()
            .ok()
            .flatten()
            .and_then(|s| {
                s.assignments
                    .iter()
                    .find(|a| a.agent_id == to)
                    .map(|a| a.owned_paths.clone())
            })
            .unwrap_or_default();
        let owned = if owned_paths.is_empty() {
            "(no owned scope)".to_string()
        } else {
            owned_paths.join(", ")
        };

        let contracts = self
            .session
            .workspace()
            .read_contracts()
            .ok()
            .filter(|c| !c.is_empty())
            .map(|c| {
                c.iter()
                    .map(|(n, b)| format!("- {n}:\n{}", b.trim()))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_else(|| "(none published yet)".to_string());
        let excerpts = self.scope_excerpts(&owned_paths);

        let sys = format!(
            "You are \"{owner_role}\", an IC who owns {owned} on an AI engineering team. A teammate has a question about your area. Answer concretely in 1-3 sentences, grounded in YOUR ACTUAL CODE shown below: if they need a type/interface/API, give the exact signature as it really exists; if you haven't built that part yet, say so and state what it WILL be. Do not write files — just answer."
        );
        let user = format!(
            "Your published contracts:\n{contracts}\n\nExcerpts from the files you own:\n{excerpts}\n\nQuestion from {}:\n{}",
            self.agent_id, question
        );
        complete_text(
            self.client,
            &self.model,
            &sys,
            &user,
            self.max_tokens,
            &self.cancel,
            None,
        )
        .await
        .unwrap_or_else(|e| format!("(no answer — {e})"))
    }

    /// Read a bounded set of excerpts from the files an owner owns, so its
    /// answer reflects what it actually built. Caps the file count and the
    /// bytes per file so a large scope can't blow the context window.
    fn scope_excerpts(&self, owned_paths: &[String]) -> String {
        const MAX_FILES: usize = 6;
        const MAX_BYTES_PER_FILE: usize = 2 * 1024;
        let mut files: Vec<PathBuf> = Vec::new();
        for rel in owned_paths {
            if files.len() >= MAX_FILES {
                break;
            }
            if let Some(full) = resolve_in_repo(&self.repo_root, rel) {
                collect_files(&full, MAX_FILES, &mut files);
            }
        }
        files.truncate(MAX_FILES);
        if files.is_empty() {
            return "(no files written yet)".to_string();
        }
        files
            .iter()
            .map(|f| {
                let shown = f
                    .strip_prefix(&self.repo_root)
                    .unwrap_or(f)
                    .to_string_lossy()
                    .replace('\\', "/");
                match std::fs::read(f) {
                    Ok(bytes) => {
                        let truncated = bytes.len() > MAX_BYTES_PER_FILE;
                        let slice = &bytes[..bytes.len().min(MAX_BYTES_PER_FILE)];
                        let mut body = String::from_utf8_lossy(slice).into_owned();
                        if truncated {
                            body.push_str("\n…(truncated)…");
                        }
                        format!("--- {shown} ---\n{body}")
                    }
                    Err(_) => format!("--- {shown} (unreadable) ---"),
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Render the channel summary for this IC's turn.
    fn summary(&self) -> String {
        let head = match &self.finish_note {
            Some(n) if !n.trim().is_empty() => n.trim().to_string(),
            _ => "Finished my scope.".to_string(),
        };
        let changed = if self.changed.is_empty() {
            format!("{head} (no files changed)")
        } else {
            format!(
                "{head} Changed {} file(s): {}",
                self.changed.len(),
                self.changed.join(", ")
            )
        };
        if self.blocking_errors.is_empty() {
            changed
        } else {
            format!(
                "{changed} Blocking tool error(s): {}",
                self.blocking_errors.join(" | ")
            )
        }
    }
}

fn is_blocking_tool_error(content: &str) -> bool {
    content.starts_with("WRITE REJECTED:")
        || content.starts_with("EDIT REJECTED:")
        || content.starts_with("DELETE REJECTED:")
        || content.starts_with("finish rejected:")
}

fn compact_tool_error(content: &str) -> String {
    const MAX_CHARS: usize = 240;
    let one_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = one_line.chars();
    let compact: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

fn ic_core_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    crate::tools::file_workspace_search::register(&mut registry, Arc::new(NoopIdeEventSink));
    registry
}

fn core_tool_schemas() -> Vec<ToolSchema> {
    let registry = ic_core_registry();
    IC_CORE_TOOL_NAMES
        .iter()
        .filter_map(|name| {
            registry
                .get(name)
                .map(|tool| team_tool_schema(tool.schema()))
        })
        .collect()
}

fn team_tool_schema(mut schema: ToolSchema) -> ToolSchema {
    match schema.name.as_str() {
        "file_write" | "file_edit" | "move_path" | "delete_path" | "folder_create" => {
            schema
                .description
                .push_str(" Team scope rule: only call this for paths inside your owned scope.");
        }
        "file_read" | "workspace_tree" | "grep" => {
            schema.description.push_str(
                " Team scope rule: reads may inspect any repo path; prefer repo-relative paths.",
            );
        }
        _ => {}
    }
    schema
}

fn search_text_to_grep(input: &serde_json::Value) -> serde_json::Value {
    json!({
        "pattern": input.get("query").and_then(|v| v.as_str()).unwrap_or_default(),
        "path": input.get("path").and_then(|v| v.as_str()).unwrap_or("."),
        "is_regex": false,
        "output_mode": "content"
    })
}

fn rejection_prefix(tool_name: &str) -> &'static str {
    match tool_name {
        "file_edit" => "EDIT REJECTED",
        "delete_path" => "DELETE REJECTED",
        _ => "WRITE REJECTED",
    }
}

fn tool_result_success(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|v| v.get("success").and_then(|s| s.as_bool()).or(Some(true)))
        .unwrap_or(true)
}

#[derive(Debug, PartialEq, Eq)]
enum PathFingerprint {
    Missing,
    File(Vec<u8>),
    Dir,
}

fn path_fingerprint(path: &Path) -> PathFingerprint {
    if path.is_file() {
        std::fs::read(path)
            .map(PathFingerprint::File)
            .unwrap_or(PathFingerprint::Missing)
    } else if path.is_dir() {
        PathFingerprint::Dir
    } else {
        PathFingerprint::Missing
    }
}

/// Overwrite `agents/<id>/session.jsonl` with the current transcript so the
/// per-agent view in the team window can stream this IC's tool calls + results
/// live as it works (best-effort; a persist failure must not abort the build).
fn persist_session(session: &TeamSession, agent_id: &str, messages: &[ConversationMessage]) {
    let lines: Vec<String> = messages
        .iter()
        .filter_map(|m| serde_json::to_string(m).ok())
        .collect();
    let _ = session.workspace().write_agent_session(agent_id, &lines);
}

/// Resolve a repo-relative path against the repo root, rejecting anything the
/// scope guard would (absolute / `..` traversal) so a write can never escape
/// the repo even before ownership is checked.
fn resolve_in_repo(repo_root: &Path, rel: &str) -> Option<PathBuf> {
    let norm = scope_guard::normalize_repo_rel(rel)?;
    Some(repo_root.join(norm))
}

/// Gather up to `cap` regular files at/under `path` (a file path yields
/// itself), skipping dot/vendor/build directories. Used to ground an owner's
/// boundary answer in the files it actually wrote.
fn collect_files(path: &Path, cap: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= cap {
        return;
    }
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| (!e.path().is_dir(), e.file_name()));
    for e in items {
        if out.len() >= cap {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if p.is_dir() {
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "target" | "dist" | "build" | "out" | "vendor"
                )
            {
                continue;
            }
            collect_files(&p, cap, out);
        } else {
            out.push(p);
        }
    }
}

/// Pull a string argument out of a tool-call input object.
fn str_arg(input: &serde_json::Value, key: &str) -> Option<String> {
    input.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// The owned paths for an agent, if it has an assignment.
fn owned_paths_of(scope: &ScopeMap, agent_id: &str) -> Option<Vec<String>> {
    scope
        .assignments
        .iter()
        .find(|a| a.agent_id == agent_id)
        .map(|a| a.owned_paths.clone())
}

/// Titles of the (incomplete) tasks the board has assigned to an agent.
fn ic_task_titles(session: &TeamSession, agent_id: &str) -> Result<Vec<String>, RuntimeError> {
    let board = session.workspace().read_tasks()?;
    Ok(board
        .map(|b| {
            b.tasks
                .into_iter()
                .filter(|t| t.owner.as_deref() == Some(agent_id))
                .filter(|t| !matches!(t.status, TaskStatus::Done))
                .map(|t| t.title)
                .collect()
        })
        .unwrap_or_default())
}

// ─── model-call helper ────────────────────────────────────────────────────

/// One tool-enabled completion: send `system` + the running `messages` with
/// the tool catalogue and return the full reconstructed turn. Streams into a
/// drained sink so the provider adapter never blocks (deltas are for the live
/// UI; the build runner acts on the returned message).
async fn complete_turn(
    client: &Arc<dyn StreamingApiClient>,
    model: &str,
    max_output_tokens: u32,
    system: &str,
    messages: &[ConversationMessage],
    tools: &[ToolSchema],
    cancel: &CancellationToken,
    streamer: Option<&TeamStreamer<'_>>,
) -> Result<crate::agent_runtime::api_client::TurnUsage, RuntimeError> {
    let request = ApiRequest {
        model,
        system_prompt: Some(system),
        messages,
        tools,
        temperature: None,
        max_output_tokens,
        thinking_enabled: false,
    };
    let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
    let stream_fut = client.stream(request, tx, cancel.clone());
    // Forward this build turn's tokens/thinking to the Team view live — the
    // per-agent transcript otherwise only updates once per round (on persist).
    if let Some(s) = streamer {
        s.start();
    }
    let drain_fut = async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                AssistantEvent::TextDelta { delta } => {
                    if let Some(s) = streamer {
                        s.text(&delta);
                    }
                }
                AssistantEvent::Thinking { text, .. } => {
                    if let Some(s) = streamer {
                        s.thinking(&text);
                    }
                }
                _ => {}
            }
        }
    };
    // Bound the build turn: a hung provider must fail this IC cleanly (it's
    // then marked Blocked) instead of stranding the whole background run.
    let joined = async { tokio::join!(stream_fut, drain_fut) };
    let (res, ()) = match tokio::time::timeout(TEAM_MODEL_CALL_TIMEOUT, joined).await {
        Ok(pair) => {
            if let Some(s) = streamer {
                s.end();
            }
            pair
        }
        Err(_) => {
            if let Some(s) = streamer {
                s.end();
            }
            cancel.cancel();
            return Err(RuntimeError::InvalidState(format!(
                "team build turn timed out after {}s (the provider connected but never completed the response)",
                TEAM_MODEL_CALL_TIMEOUT.as_secs()
            )));
        }
    };
    Ok(res?)
}

// ─── tools + prompt ─────────────────────────────────────────────────────────

/// The IC build catalogue. `write_file` and `delete_file` are scope-guarded;
/// reads and search are unrestricted (an agent may read anywhere to
/// understand the codebase).
fn ic_build_tools() -> Vec<ToolSchema> {
    let mut tools = core_tool_schemas();
    tools.extend([
        ToolSchema {
            name: "send_message".into(),
            description: "Say something in the team group chat — the Lead and your teammates see \
                          it live. Use @agent-id when asking a specific teammate a question; use \
                          @lead to reach the Lead for direction, a blocker, or a scope-access \
                          request (the Lead can grant access). The reply comes back in this tool \
                          result. This is plain conversation, not a file edit."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "your message to the team" }
                },
                "required": ["text"]
            }),
        },
        ToolSchema {
            name: "publish_contract".into(),
            description: "Publish a shared interface other agents can depend on without editing \
                          your files (e.g. an exported type or API shape)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "body": { "type": "string", "description": "the interface definition / signature" }
                },
                "required": ["name", "body"]
            }),
        },
        ToolSchema {
            name: "ask_owner".into(),
            description: "Ask the owner of another scope a boundary question instead of editing \
                          across the line. Use to=\"lead\" to ask the Lead for direction or for \
                          write access to a path outside your scope — the Lead can grant it."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "the owning agent's id (e.g. ui-owner-1234), or \"lead\" for the Lead" },
                    "question": { "type": "string" }
                },
                "required": ["to", "question"]
            }),
        },
        ToolSchema {
            name: "finish".into(),
            description:
                "Call when your scope is built. Provide a one-line summary of what you did.".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } }
            }),
        },
    ]);
    tools
}

fn ic_build_prompt(role: &str, owned: &[String], tasks: &[String]) -> String {
    let scope = if owned.is_empty() {
        "(none yet)".to_string()
    } else {
        owned.join(", ")
    };
    let task_list = if tasks.is_empty() {
        "  (no seeded tasks — use your judgment to build your scope)".to_string()
    } else {
        tasks
            .iter()
            .map(|t| format!("  - {t}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "You are \"{role}\", an IC on an autonomous AI engineering team building inside the Aurora IDE on the user's real repository.

You OWN these paths and may write ONLY inside them: {scope}
A write (or delete) outside your scope is rejected by the scope guard, which tells you who owns the path. When you need something another agent owns, do NOT try to edit it — use `ask_owner`, or rely on a `publish_contract` they shared. If others depend on an interface you own, `publish_contract` it.

Your seeded tasks:
{task_list}

Your teammates are building their scopes AT THE SAME TIME as you — the team works in parallel. Check the team context and recent chat for contracts and decisions, and share yours early so others can depend on them.

You have the same file tools the normal Aurora agent uses to build a project — just limited to your scope:
- Read / inspect (anywhere): `file_read` (pass `path`, or `paths` for a batch), `workspace_tree`, `grep`, `auroro_websearch` for docs.
- Create & write (your scope only): `file_write` for new or full files, `folder_create` to scaffold directories.
- Edit (your scope only): `file_edit` — exact-text find-and-replace, single (`old_string`/`new_string`) or several edits in one atomic call (`edits` array). Read the file with `file_read` first.
- Move / remove (your scope only): `move_path` to move or rename, `delete_path` for obsolete files (or folders with `recursive: true`).

Build real, complete files — no placeholders or TODOs. Keep the team in the loop:
- `send_message` to talk in the group chat. If you @mention a teammate's id with a question, they answer you back right then (the reply comes back in your tool result).
- `ask_owner` when you need something from a scope you don't own — never edit across the line.
- `@lead` (in `send_message`, or `ask_owner` with to=\"lead\") to reach the LEAD: ask for direction, report a blocker, or request write access to a path outside your scope — the Lead can grant it on the spot.
- `publish_contract` for any interface others depend on, early, so they don't guess.
When your scope is built, call `finish` with a one-line summary. Be efficient — avoid unnecessary tool calls."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::{ApiError, TurnUsage};
    use crate::agent_runtime::team::types::{AgentStatus, TeamPhase};
    use crate::agent_runtime::team::workspace::ProjectWorkspace;
    use crate::agent_runtime::types::TokenUsage;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Scripted IC: first turn writes one in-scope file and one out-of-scope
    /// file (to exercise the guard), second turn calls `finish`.
    struct ScriptedBuilder {
        turns: Mutex<HashMap<String, usize>>,
        in_scope_path: String,
        out_scope_path: Option<String>,
    }

    impl ScriptedBuilder {
        fn new(in_scope: &str, out_scope: &str) -> Self {
            Self {
                turns: Mutex::new(HashMap::new()),
                in_scope_path: in_scope.into(),
                out_scope_path: Some(out_scope.into()),
            }
        }

        fn in_scope_only(in_scope: &str) -> Self {
            Self {
                turns: Mutex::new(HashMap::new()),
                in_scope_path: in_scope.into(),
                out_scope_path: None,
            }
        }
    }

    fn role_key(request: &ApiRequest<'_>) -> String {
        let system = request.system_prompt.unwrap_or_default();
        system
            .split_once("You are \"")
            .and_then(|(_, rest)| rest.split_once('"').map(|(role, _)| role.to_string()))
            .unwrap_or_else(|| "agent".to_string())
    }

    #[async_trait]
    impl StreamingApiClient for ScriptedBuilder {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let role = role_key(&request);
            let n = {
                let mut turns = self.turns.lock().unwrap();
                let n = *turns.get(&role).unwrap_or(&0);
                turns.insert(role, n + 1);
                n
            };
            let blocks = if n == 0 {
                let mut blocks = vec![ContentBlock::ToolUse {
                    id: "w1".into(),
                    name: "write_file".into(),
                    input: json!({ "path": self.in_scope_path, "content": "hello world" }),
                }];
                if let Some(out_scope_path) = &self.out_scope_path {
                    blocks.push(ContentBlock::ToolUse {
                        id: "w2".into(),
                        name: "write_file".into(),
                        input: json!({ "path": out_scope_path, "content": "nope" }),
                    });
                }
                blocks
            } else {
                vec![ContentBlock::ToolUse {
                    id: "f1".into(),
                    name: "finish".into(),
                    input: json!({ "summary": "built my scope" }),
                }]
            };
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: String::new(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "tool_use".into(),
                assistant_message: ConversationMessage::assistant(blocks, 0),
            })
        }
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, TeamSession, TeamBus) {
        let brain = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-build", brain.path().join("pid-build"));
        ws.ensure_scaffold(repo.path().to_str().unwrap(), None)
            .unwrap();
        (
            brain,
            repo,
            TeamSession::with_workspace(ws),
            TeamBus::headless(),
        )
    }

    /// Plays the LEAD in a boundary consultation: grants the asked path via
    /// the `GRANT:` directive. Any non-lead call just acks.
    struct GrantingLeadApi;

    #[async_trait]
    impl StreamingApiClient for GrantingLeadApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let is_lead = request
                .system_prompt
                .map(|s| s.contains("LEAD engineer coordinating"))
                .unwrap_or(false);
            let text = if is_lead {
                "Yes — that file is core to your slice, take ownership.\nGRANT: shared/config.json"
                    .to_string()
            } else {
                "ok".to_string()
            };
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: text.clone(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage::assistant(
                    vec![ContentBlock::Text { text }],
                    0,
                ),
            })
        }
    }

    #[tokio::test]
    async fn lead_mention_answers_and_grants_scope_access() {
        // An IC asks the LEAD (ask_owner to="lead") for write access to a path
        // a PEER owns. The Lead answers in character and issues a GRANT — the
        // path must move to the asker's scope (non-overlap preserved) and the
        // visible reply must carry the human note, not the raw directive.
        let (_brain, repo, session, bus) = fixture();
        let team = session
            .convene(
                &bus,
                super::super::orchestrator::ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![
                        super::super::orchestrator::AgentSpec {
                            role: "api".into(),
                            model: None,
                        },
                        super::super::orchestrator::AgentSpec {
                            role: "ui".into(),
                            model: None,
                        },
                    ],
                },
                5,
            )
            .unwrap();
        let ids: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect();
        let (asker, peer) = (ids[0].clone(), ids[1].clone());
        session
            .assign_scope(&bus, &asker, vec!["api/".into()], vec![])
            .unwrap();
        session
            .assign_scope(
                &bus,
                &peer,
                vec!["shared/".into(), "shared/config.json".into()],
                vec![],
            )
            .unwrap();

        let client: Arc<dyn StreamingApiClient> = Arc::new(GrantingLeadApi);
        let roster: Vec<(String, String)> = team
            .agents
            .iter()
            .map(|a| (a.id.clone(), a.role.clone()))
            .collect();
        let mut exec = BuildTools::new(
            &session,
            &bus,
            repo.path().to_path_buf(),
            asker.clone(),
            &client,
            "team-model".into(),
            512,
            CancellationToken::new(),
            roster,
        );

        let (reply, is_error) = exec
            .ask_owner(&json!({
                "to": "lead",
                "question": "I need write access to shared/config.json for my API wiring."
            }))
            .await
            .unwrap();
        assert!(!is_error, "lead consult failed: {reply}");
        assert!(
            reply.contains("Access granted: shared/config.json"),
            "reply must carry the grant note: {reply}"
        );
        assert!(
            !reply.contains("GRANT:"),
            "the raw directive must be stripped from the visible reply: {reply}"
        );

        // The scope map moved the path: asker owns it, the peer no longer does.
        let scope = session.workspace().read_scope_map().unwrap().unwrap();
        let mine = scope
            .assignments
            .iter()
            .find(|a| a.agent_id == asker)
            .unwrap();
        assert!(mine.owned_paths.iter().any(|p| p == "shared/config.json"));
        let theirs = scope
            .assignments
            .iter()
            .find(|a| a.agent_id == peer)
            .unwrap();
        assert!(
            !theirs.owned_paths.iter().any(|p| p == "shared/config.json"),
            "assign_scope must strip the granted path from the previous owner"
        );

        // And the write is now allowed for the asker.
        let decision = session.check_write(&asker, "shared/config.json").unwrap();
        assert!(
            decision.allowed,
            "granted path must be writable: {}",
            decision.reason
        );
    }

    #[tokio::test]
    async fn build_blocks_peer_writes_but_completes_with_deliverables() {
        // Two ICs partition the repo: ic-a owns api/, ic-b owns ui/. Each runs
        // the same script — write one in-scope file + poke the OTHER's scope.
        // The peer poke is blocked (the partition's real job), but because each
        // member wrote its own deliverable the run COMPLETES and rolls to
        // Integrating instead of being thrown away. This is the fix for the
        // real-world failure where one stray rejection nuked the whole team.
        let (_brain, repo, session, bus) = fixture();

        let team = session
            .convene(
                &bus,
                super::super::orchestrator::ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![
                        super::super::orchestrator::AgentSpec {
                            role: "api".into(),
                            model: None,
                        },
                        super::super::orchestrator::AgentSpec {
                            role: "ui".into(),
                            model: None,
                        },
                    ],
                },
                5,
            )
            .unwrap();
        let ids: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect();
        session
            .assign_scope(&bus, &ids[0], vec!["api/".into()], vec![])
            .unwrap();
        session
            .assign_scope(&bus, &ids[1], vec!["ui/".into()], vec![])
            .unwrap();

        // Each IC writes its in-scope file, then tries the peer's file.
        let client: Arc<dyn StreamingApiClient> =
            Arc::new(ScriptedBuilder::new("api/handler.rs", "ui/forbidden.rs"));

        run_build_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            "build it",
        )
        .await
        .expect("a producing team must complete, not fail over a peer-boundary poke");

        // Each owner's own file landed (written by whoever rightfully owns it).
        assert!(repo.path().join("api/handler.rs").exists());
        assert!(repo.path().join("ui/forbidden.rs").exists());

        // The cross-scope attempts WERE blocked — at least one IC summary shows
        // a rejection, proving the peer boundary still holds.
        let chan = session.workspace().read_channel(None).unwrap();
        assert!(
            chan.iter().any(|e| e.body.contains("REJECTED")),
            "a peer write must be rejected and surfaced in the channel"
        );

        // All ICs produced deliverables → the team reports done.
        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            matches!(team.phase, TeamPhase::Done),
            "phase: {:?}",
            team.phase
        );
        assert!(team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .all(|a| matches!(a.status, AgentStatus::Done)));
    }

    #[tokio::test]
    async fn build_posts_a_summary_per_ic() {
        let (_brain, repo, session, bus) = fixture();
        let team = session
            .convene(
                &bus,
                super::super::orchestrator::ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![super::super::orchestrator::AgentSpec {
                        role: "api".into(),
                        model: None,
                    }],
                },
                5,
            )
            .unwrap();
        let ic = team
            .agents
            .iter()
            .find(|a| a.id != LEAD_AGENT_ID)
            .unwrap()
            .id
            .clone();
        session
            .assign_scope(&bus, &ic, vec!["api/".into()], vec![])
            .unwrap();

        let client: Arc<dyn StreamingApiClient> =
            Arc::new(ScriptedBuilder::in_scope_only("api/handler.rs"));
        run_build_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            "go",
        )
        .await
        .unwrap();

        let chan = session.workspace().read_channel(None).unwrap();
        let ic_summary = chan
            .iter()
            .find(|e| e.author == ic && matches!(e.kind, ChannelEventKind::Message));
        let body = &ic_summary.expect("an IC build summary").body;
        assert!(
            body.contains("api/handler.rs"),
            "summary names changed file: {body}"
        );
    }

    /// Client whose every model call blocks on a 2-party barrier before
    /// returning `finish`. The barrier only releases when BOTH ICs' calls are
    /// in flight simultaneously — under the old sequential build this
    /// deadlocks, so the test passing is proof the build is truly parallel.
    struct BarrierClient {
        barrier: Arc<tokio::sync::Barrier>,
    }

    #[async_trait]
    impl StreamingApiClient for BarrierClient {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            self.barrier.wait().await;
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: String::new(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "tool_use".into(),
                assistant_message: ConversationMessage::assistant(
                    vec![ContentBlock::ToolUse {
                        id: "f".into(),
                        name: "finish".into(),
                        input: json!({ "summary": "done" }),
                    }],
                    0,
                ),
            })
        }
    }

    #[tokio::test]
    async fn build_runs_ics_concurrently() {
        let (_brain, repo, session, bus) = fixture();
        let team = session
            .convene(
                &bus,
                super::super::orchestrator::ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![
                        super::super::orchestrator::AgentSpec {
                            role: "api".into(),
                            model: None,
                        },
                        super::super::orchestrator::AgentSpec {
                            role: "ui".into(),
                            model: None,
                        },
                    ],
                },
                5,
            )
            .unwrap();
        let ids: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect();
        session
            .assign_scope(&bus, &ids[0], vec!["api/".into()], vec![])
            .unwrap();
        session
            .assign_scope(&bus, &ids[1], vec!["ui/".into()], vec![])
            .unwrap();

        let client: Arc<dyn StreamingApiClient> = Arc::new(BarrierClient {
            barrier: Arc::new(tokio::sync::Barrier::new(2)),
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            run_build_inner(&bus, &session, repo.path(), &client, "m", 256, "go"),
        )
        .await
        .expect("ICs must build in parallel — a sequential build deadlocks on the barrier");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("no changed files/effective writes"),
            "a team that builds nothing must fail verification"
        );

        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            matches!(team.phase, TeamPhase::Building),
            "phase: {:?}",
            team.phase
        );
    }

    struct PartialBuilder {
        turns: Mutex<HashMap<String, usize>>,
    }

    #[async_trait]
    impl StreamingApiClient for PartialBuilder {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let role = role_key(&request);
            let n = {
                let mut turns = self.turns.lock().unwrap();
                let n = *turns.get(&role).unwrap_or(&0);
                turns.insert(role.clone(), n + 1);
                n
            };
            let blocks = if role == "api" && n == 0 {
                vec![ContentBlock::ToolUse {
                    id: "w".into(),
                    name: "write_file".into(),
                    input: json!({ "path": "api/handler.rs", "content": "hello world" }),
                }]
            } else {
                vec![ContentBlock::ToolUse {
                    id: "f".into(),
                    name: "finish".into(),
                    input: json!({ "summary": "done" }),
                }]
            };
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: String::new(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "tool_use".into(),
                assistant_message: ConversationMessage::assistant(blocks, 0),
            })
        }
    }

    #[tokio::test]
    async fn build_fails_when_any_scoped_ic_changes_nothing() {
        let (_brain, repo, session, bus) = fixture();
        let team = session
            .convene(
                &bus,
                super::super::orchestrator::ConveneRequest {
                    lead_model: None,
                    stack: None,
                    agents: vec![
                        super::super::orchestrator::AgentSpec {
                            role: "api".into(),
                            model: None,
                        },
                        super::super::orchestrator::AgentSpec {
                            role: "ui".into(),
                            model: None,
                        },
                    ],
                },
                5,
            )
            .unwrap();
        let ids: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect();
        session
            .assign_scope(&bus, &ids[0], vec!["api/".into()], vec![])
            .unwrap();
        session
            .assign_scope(&bus, &ids[1], vec!["ui/".into()], vec![])
            .unwrap();

        let client: Arc<dyn StreamingApiClient> = Arc::new(PartialBuilder {
            turns: Mutex::new(HashMap::new()),
        });
        let err = run_build_inner(
            &bus,
            &session,
            repo.path(),
            &client,
            "team-model",
            1024,
            "build it",
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(repo.path().join("api/handler.rs").exists());
        assert!(
            err.contains("no changed files/effective writes"),
            "unexpected error: {err}"
        );

        let team = session.workspace().read_team().unwrap().unwrap();
        assert!(
            matches!(team.phase, TeamPhase::Building),
            "phase: {:?}",
            team.phase
        );
        let api = team.agents.iter().find(|a| a.role == "api").unwrap();
        let ui = team.agents.iter().find(|a| a.role == "ui").unwrap();
        assert!(matches!(api.status, AgentStatus::Done));
        assert!(matches!(ui.status, AgentStatus::Blocked));
    }

    #[test]
    fn ic_catalogue_has_the_full_project_building_toolset() {
        let names: Vec<String> = ic_build_tools().into_iter().map(|t| t.name).collect();
        // Read / inspect / research (unrestricted).
        for expected in ["file_read", "workspace_tree", "grep", "auroro_websearch"] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing read tool {expected}"
            );
        }
        // Write / edit / scaffold (scope-guarded) — the tools a member needs to
        // actually create a project, not just a single write_file.
        for expected in [
            "file_write",
            "file_edit",
            "move_path",
            "delete_path",
            "folder_create",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing write tool {expected}"
            );
        }
        // NO orphans: every advertised name must exist in the core registry
        // (plus the four lateral tools) — a schema for a tool the executor
        // can't run burns IC turns on "unknown tool" errors.
        let registry = ic_core_registry();
        for name in &names {
            let lateral = matches!(
                name.as_str(),
                "send_message" | "publish_contract" | "ask_owner" | "finish"
            );
            assert!(
                lateral || registry.get(name).is_some(),
                "advertised tool '{name}' has no executor in the core registry"
            );
        }
        // Lateral coordination.
        for expected in ["send_message", "publish_contract", "ask_owner", "finish"] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing comms tool {expected}"
            );
        }
        // Every guarded write tool carries the scope rule in its description.
        let schema = |name: &str| {
            ic_build_tools()
                .into_iter()
                .find(|t| t.name == name)
                .unwrap()
                .description
        };
        assert!(schema("file_edit").contains("owned scope"));
        assert!(schema("move_path").contains("owned scope"));
        assert!(schema("delete_path").contains("owned scope"));
        assert!(schema("folder_create").contains("owned scope"));
    }

    #[test]
    fn resolve_in_repo_blocks_traversal() {
        let root = Path::new("/repo");
        assert!(resolve_in_repo(root, "../escape").is_none());
        assert_eq!(
            resolve_in_repo(root, "src/api/x.rs"),
            Some(root.join("src/api/x.rs"))
        );
    }
}
