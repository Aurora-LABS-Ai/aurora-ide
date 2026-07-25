//! `TeamRunner` — the **live planning round** (ground truth §9 "Planning",
//! §16 Phase 2b).
//!
//! Phase 2a gave the Lead a pure state machine (convene / assign / disband).
//! Phase 2b drives that state machine with **real model calls**: the Lead
//! reasons about the user's goal and proposes a team + a non-overlapping
//! scope partition + a seeded board; each IC then runs a one-shot standup
//! turn to acknowledge its scope and flag boundary concerns. Every step is
//! posted through the [`TeamBus`] so the whole round is persisted to
//! `channel/events.jsonl` **and** streamed live to the team view in one
//! path (no side channels).
//!
//! ## Where the model calls come from
//!
//! The runner reuses Aurora's existing provider stack verbatim: it builds a
//! [`crate::api::build_api_client`] from a [`ProviderConfigSnapshot`] and
//! talks to it through the [`StreamingApiClient`] trait. There is **no**
//! parallel HTTP implementation.
//!
//! The Lead and the IC team can ride **different** providers/models: the
//! caller passes two snapshots (resolved from the user's Agent → Team
//! settings — `teamLeadModel` / `teamMemberModel`, each a selection from an
//! already-configured provider, defaulting to the active chat model). This
//! lets the user pin the Lead to, say, a strong reasoning model and the
//! parallel team to a cheaper/faster one.
//!
//! ## Lead = a role on the chat agent (locked decision, §17)
//!
//! The Lead is not a distinct agent process; it is the chat agent acting in
//! team mode. The runner is what the Lead "becomes" for the duration of the
//! planning round. ICs are lightweight one-shot model runs the runner
//! orchestrates — they have no chat surface of their own.
//!
//! ## Scope of Phase 2b
//!
//! This is the **planning** round only. It ends with scopes locked and the
//! board seeded, the team left in [`TeamPhase::Planning`]. The parallel
//! build (flipping agents to `Building`, enforcing scope on writes) is
//! Phase 3 and deliberately not done here.

#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_runtime::api_client::{ApiRequest, StreamingApiClient};
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use crate::api::{build_api_client, ProviderConfigSnapshot};

use super::bus::{TeamBus, TeamStreamer};
use super::orchestrator::{
    AgentSpec, ConveneRequest, TeamSession, LEAD_AGENT_ID, TEAM_SIZE_HARD_CEILING,
};
use super::types::{
    AgentRecord, AgentStatus, ChannelEvent, ChannelEventKind, TeamPhase, TeamProjectState,
};
use super::workspace::{now_rfc3339, DEFAULT_CHANNEL_TAIL};

/// Fallback output-token budget used ONLY when the provider config doesn't
/// specify one (`default_max_tokens == None`).
///
/// We do **not** hardcode the real cap. The Lead/team models are often
/// **reasoning** models (e.g. Kimi-K2) that spend a large, variable share of
/// the budget on hidden chain-of-thought before any visible text; a tight cap
/// lets the whole budget go to reasoning and produces EMPTY output (a failed
/// plan parse, or a build turn that "thinks about writing files" and ends with
/// none written). The real budget comes from the user's model integration
/// settings via [`resolved_max_tokens`] — which can be very large (128k+).
/// This constant is just a sane floor for the degenerate "unset" case.
const FALLBACK_MAX_OUTPUT_TOKENS: u32 = 8192;

/// Wall-clock ceiling for a single team model call. A provider that connects
/// but then hangs (never streams a token, never closes) must not strand the
/// whole background run — and, worse, stick-lock the one-run-per-workspace
/// guard until the app is restarted. On elapse we fire the cancel token and
/// surface a timeout error, which fails the phase cleanly so the dispatcher
/// marks the run Failed and frees the guard. Generous by design: reasoning
/// models legitimately spend minutes on hidden chain-of-thought.
pub(crate) const TEAM_MODEL_CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Resolve the output-token budget for a team model call from the provider's
/// configured `default_max_tokens` (the user's model setting), falling back to
/// [`FALLBACK_MAX_OUTPUT_TOKENS`] only when unset. Shared by every team runner
/// (planning, build, integration) so no call ever truncates a reasoning model
/// with a hardcoded cap.
pub(crate) fn resolved_max_tokens(provider: &ProviderConfigSnapshot) -> u32 {
    provider
        .default_max_tokens
        .filter(|&n| n > 0)
        .unwrap_or(FALLBACK_MAX_OUTPUT_TOKENS)
}

// ─── the Lead's plan, as parsed from its JSON reply ───────────────────────

/// One IC the Lead proposes in its plan. `role` is dynamic (named for this
/// project); `scope`/`tasks` may be empty (the Lead can convene a placeholder
/// it fills in later, or hand out work in the build phase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedAgent {
    #[serde(default)]
    role: String,
    #[serde(default)]
    scope: Vec<String>,
    #[serde(default)]
    tasks: Vec<String>,
    #[serde(default)]
    model: Option<String>,
}

/// The Lead's whole plan. Tolerant by construction: every field defaults so
/// a model that omits `stack`/`summary` still parses, and unknown keys are
/// ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeadPlan {
    #[serde(default)]
    stack: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    agents: Vec<PlannedAgent>,
}

// ─── public entry point ───────────────────────────────────────────────────

/// Run the live planning round for a repo and return the resulting brain
/// snapshot. Live lifecycle events stream on the `"team_event"` channel via
/// `bus` as they happen; the returned [`TeamProjectState`] is the settled
/// state for the caller to hand back to the frontend store.
///
/// `lead_provider` drives the Lead's planning call; `team_provider` drives
/// every IC standup. They may be the same snapshot (the default — both
/// resolve to the active chat model) or two different configured providers.
///
/// `desired_ics` is the user's explicit team size when they asked for one
/// (e.g. "spin up 3 members" → `Some(3)`). When present it forces the team
/// to staff exactly that many ICs (clamped to the cap); when `None` the Lead
/// sizes the team to the work.
pub async fn run_planning(
    bus: &TeamBus,
    repo_path: &str,
    goal: &str,
    lead_provider: &ProviderConfigSnapshot,
    team_provider: &ProviderConfigSnapshot,
    max_size: usize,
    desired_ics: Option<usize>,
) -> Result<TeamProjectState, RuntimeError> {
    let session = TeamSession::open(repo_path)?;
    let lead_client = build_api_client(lead_provider);
    let lead_model = lead_provider.model.clone();
    let lead_max = resolved_max_tokens(lead_provider);
    let team_client = build_api_client(team_provider);
    let team_model = team_provider.model.clone();
    let team_max = resolved_max_tokens(team_provider);
    run_planning_inner(
        bus,
        &session,
        &lead_client,
        &lead_model,
        lead_max,
        &team_client,
        &team_model,
        team_max,
        Path::new(repo_path),
        goal,
        max_size,
        desired_ics,
    )
    .await?;
    session.workspace().load_state(Some(DEFAULT_CHANNEL_TAIL))
}

/// Testable core: drive the planning round over an already-opened session
/// with injected API clients. `run_planning` is the thin production wrapper
/// that resolves the session + builds the real clients.
///
/// Two client/model pairs: the Lead planning call uses `lead_client` /
/// `lead_model`; every IC standup uses `team_client` / `team_model`.
#[allow(clippy::too_many_arguments)]
async fn run_planning_inner(
    bus: &TeamBus,
    session: &TeamSession,
    lead_client: &Arc<dyn StreamingApiClient>,
    lead_model: &str,
    lead_max: u32,
    team_client: &Arc<dyn StreamingApiClient>,
    team_model: &str,
    team_max: u32,
    repo_root: &Path,
    goal: &str,
    max_size: usize,
    desired_ics: Option<usize>,
) -> Result<(), RuntimeError> {
    let cancel = CancellationToken::new();
    let cap = max_size.min(TEAM_SIZE_HARD_CEILING).max(1);
    let ic_cap = cap - 1; // one slot is always the Lead

    // An explicit user request ("spin up 3 members") forces the count; clamp
    // it to the cap and drop a zero/empty request so it behaves like "None".
    let desired = desired_ics.map(|n| n.min(ic_cap)).filter(|&n| n > 0);

    // Live streaming: the Lead's planning call is long (a reasoning model can
    // take a minute+), so stream its tokens/thinking to the Team view as they
    // arrive instead of leaving the screen frozen until the plan returns.
    let project_id = session.workspace().project_id().to_string();
    // The plan reply is machine JSON, not chat — stream it as the Lead's
    // "reasoning" so the group chat never shows raw JSON as a message.
    let lead_streamer = TeamStreamer::new(bus, project_id.clone(), LEAD_AGENT_ID, "planning", None)
        .text_as_thinking();

    // 1. Lead planning call → JSON plan (on the Lead's provider/model).
    let lead_system = lead_planning_prompt(cap, ic_cap, desired);
    let repo_snapshot = planning_workspace_snapshot(repo_root);
    let lead_user = format!(
        "Project goal:\n{goal}\n\nCurrent repository layout:\n{repo_snapshot}\n\nUse ONLY real paths from this layout for ownership scopes. Do not invent `src/` if the project uses `app/`, `routes/`, or another root."
    );
    let raw = complete_text(
        lead_client,
        lead_model,
        &lead_system,
        &lead_user,
        lead_max,
        &cancel,
        Some(&lead_streamer),
    )
    .await?;
    // Parse the plan; on failure (empty/prose/truncated output — common with
    // reasoning models) retry ONCE with a stricter JSON-only instruction before
    // giving up. This turns a flaky planning round into a reliable one.
    let plan = match parse_lead_plan(&raw) {
        Ok(plan) => plan,
        Err(first_err) => {
            let repair_user = format!(
                "Project goal:\n{goal}\n\nCurrent repository layout:\n{repo_snapshot}\n\nIMPORTANT: reply with ONLY the JSON object — it MUST start with {{ and end with }}. Use ONLY real paths from the repository layout for scopes. No prose, no markdown fences, no explanation, no chain-of-thought in the answer."
            );
            let raw2 = complete_text(
                lead_client,
                lead_model,
                &lead_system,
                &repair_user,
                lead_max,
                &cancel,
                Some(&lead_streamer),
            )
            .await?;
            parse_lead_plan(&raw2).map_err(|_| first_err)?
        }
    };

    // Keep only real ICs and clamp to the cap (convene clamps again — this
    // keeps our id↔plan zip aligned with the roster convene returns).
    let mut planned = plan.agents;
    planned.retain(|a| !a.role.trim().is_empty());

    // ── v2 P1: the roster is BUILDERS ONLY ──────────────────────────────
    // A model will happily invent a "lead-engineer", "integration-owner", or
    // "qa" role. Those own no buildable work, write nothing, and used to fail
    // the run even when the real builders succeeded (the F3/F4 failures in the
    // user's runs). Coordination, review, and the gate are the LEAD's job, not
    // roster slots. So: a meta-named role that nonetheless owns real files is
    // **relabelled** to a concrete builder (its files still get built); a role
    // with no scope at all is **dropped** (it can only stall the run).
    for a in &mut planned {
        if is_meta_role(&a.role) {
            a.role = builder_role_from_scope(&a.scope);
        }
    }
    planned.retain(|a| a.scope.iter().any(|s| !s.trim().is_empty()));

    planned.truncate(ic_cap);
    // When the user named an exact size, never staff MORE than they asked for.
    // (If the model under-delivers we don't fabricate scopes here — the Lead
    // chat prompt retries `team_plan` with an explicit count instead.)
    if let Some(n) = desired {
        planned.truncate(n);
    }
    if planned.is_empty() {
        return Err(RuntimeError::InvalidState(
            "the Lead produced no IC builders; a dispatched team run cannot complete without at least one scoped builder"
                .into(),
        ));
    }

    // 2. Convene the roster (Lead + clamped ICs) → Planning phase. The Lead
    //    is recorded on its own model; every IC runs on the team model, so we
    //    stamp the roster with what each agent will actually execute on (the
    //    plan's per-agent `model` hint is advisory and not used here).
    let convene_req = ConveneRequest {
        lead_model: Some(lead_model.to_string()),
        stack: plan.stack.clone(),
        agents: planned
            .iter()
            .map(|a| AgentSpec {
                role: a.role.clone(),
                model: Some(team_model.to_string()),
            })
            .collect(),
    };
    let team = session.convene(bus, convene_req, max_size)?;

    // 3. Map each plan entry onto the id convene generated for it (roster is
    //    [lead, ic_0, ic_1, …] in plan order).
    let ic_records: Vec<AgentRecord> = team
        .agents
        .iter()
        .filter(|a| a.id != LEAD_AGENT_ID)
        .cloned()
        .collect();

    // 4. Lock scopes + seed the board (each posts a lifecycle event).
    for (rec, p) in ic_records.iter().zip(planned.iter()) {
        if !p.scope.is_empty() {
            session.assign_scope(bus, &rec.id, p.scope.clone(), Vec::new())?;
        }
        for title in &p.tasks {
            session.assign_task(bus, title.clone(), Some(rec.id.clone()), Vec::new())?;
        }
    }

    let scope_summary = scope_summary(&ic_records, &planned);

    // 4b. The Lead briefs the whole team in the group chat: the goal + the
    //     scope split. This is the message every IC then reacts to — the team
    //     literally receives the Lead's instruction and discusses it. Also
    //     recorded as a decision (§6 `decisions.md`).
    if !ic_records.is_empty() {
        let brief = format!(
            "Team, here's what we're building:\n{goal}\n\nI've split ownership below — read it, then say how you'll approach your part and flag any boundary you'll need from a teammate.\n\n{scope_summary}"
        );
        bus.post(
            session.workspace(),
            ChannelEvent {
                id: Uuid::new_v4().to_string(),
                ts: now_rfc3339(),
                author: LEAD_AGENT_ID.to_string(),
                kind: ChannelEventKind::Message,
                body: brief,
                meta: Some(json!({ "phase": "planning", "brief": true })),
            },
        )?;
        let _ = session.workspace().append_decision(&format!(
            "## Plan — {}\nGoal: {goal}\n\nScope partition:\n{scope_summary}\n",
            now_rfc3339()
        ));
    }

    // 5. Planning standup as a REAL discussion: each IC replies in roster
    //    order and — crucially — sees the Lead's brief plus everything
    //    teammates have already said, so later members react to earlier ones
    //    instead of talking into a void. Each post streams live to the team
    //    chat as it lands (the user watches them "text" in turn).
    for (rec, p) in ic_records.iter().zip(planned.iter()) {
        session.set_agent_status(&rec.id, AgentStatus::Planning)?;
        let discussion = recent_discussion(session, 16);
        let ic_system = ic_standup_prompt(&rec.role, &p.scope);
        let ic_user = format!(
            "Overall goal:\n{goal}\n\nFull scope map:\n{scope_summary}\n\nTeam chat so far:\n{discussion}\n\nReply to the team now — acknowledge your scope, say how you'll approach it, and react to a teammate or flag a boundary if relevant."
        );
        let ic_streamer =
            TeamStreamer::new(bus, project_id.clone(), rec.id.clone(), "planning", None);
        let reply = complete_text(
            team_client,
            team_model,
            &ic_system,
            &ic_user,
            team_max,
            &cancel,
            Some(&ic_streamer),
        )
        .await
        .unwrap_or_else(|e| format!("(standup skipped: {e})"));

        bus.post(
            session.workspace(),
            ChannelEvent {
                id: Uuid::new_v4().to_string(),
                ts: now_rfc3339(),
                author: rec.id.clone(),
                kind: ChannelEventKind::Message,
                body: reply,
                meta: Some(json!({ "phase": "planning", "role": rec.role })),
            },
        )?;
        session.set_agent_status(&rec.id, AgentStatus::Idle)?;
    }

    // 6. Lead wraps the round (phase stays Planning — the build is Phase 3).
    let summary = plan
        .summary
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Scopes locked and the board is seeded.".to_string());
    bus.post(
        session.workspace(),
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::System,
            body: format!("Planning complete — {summary} Ready to build."),
            meta: Some(json!({ "phase": "planning", "icCount": ic_records.len() })),
        },
    )?;

    mark_team_planning(session);

    Ok(())
}

/// Record that the planning round finished: standup posted, scopes locked.
///
/// The comment above ("phase stays Planning") described an intent the code
/// never carried out — `TeamPhase::Planning` was declared in the enum and
/// assigned nowhere, so a fully convened team with locked assignments kept
/// reporting `Forming` ("Roster not yet assembled") until the build began.
/// Both planning entry points end here.
///
/// Best-effort: a manifest that cannot be read or written must not fail a
/// planning round that otherwise succeeded — the phase is display and
/// gating state, not the work product.
fn mark_team_planning(session: &TeamSession) {
    if let Ok(Some(mut team)) = session.workspace().read_team() {
        team.phase = TeamPhase::Planning;
        team.updated_at = now_rfc3339();
        let _ = session.workspace().write_team(&team);
    }
}

// ─── dispatch with an agent-defined roster ────────────────────────────────

/// Set up the team exactly as the dispatching agent defined it in the
/// `team_dispatch` call — roles, per-member instructions, owned paths. No
/// planning model call: the caller already decided who does what. Convenes
/// the roster, locks scopes, seeds one board task per member from its
/// instructions, and posts the Lead's brief to the group chat. The assigned
/// members do not do a separate planning round; their next model call is the
/// real worker tool loop.
pub async fn run_assigned_planning(
    bus: &TeamBus,
    repo_path: &str,
    goal: &str,
    members: &[super::types::DispatchMember],
    lead_model: Option<String>,
    team_provider: &ProviderConfigSnapshot,
    max_size: usize,
) -> Result<TeamProjectState, RuntimeError> {
    let session = TeamSession::open(repo_path)?;
    let team_model = team_provider.model.clone();

    let cap = max_size.min(TEAM_SIZE_HARD_CEILING).max(1);
    let members: Vec<_> = members
        .iter()
        .filter(|m| !m.role.trim().is_empty() && !m.task.trim().is_empty())
        .take(cap - 1)
        .collect();
    if members.is_empty() {
        return Err(RuntimeError::InvalidState(
            "team_dispatch carried no usable members (each needs a role and a task)".into(),
        ));
    }

    // Convene exactly the given roster.
    let convene_req = ConveneRequest {
        lead_model,
        stack: None,
        agents: members
            .iter()
            .map(|m| AgentSpec {
                role: m.role.clone(),
                model: Some(team_model.clone()),
            })
            .collect(),
    };
    let team = session.convene(bus, convene_req, max_size)?;
    let ic_records: Vec<AgentRecord> = team
        .agents
        .iter()
        .filter(|a| a.id != LEAD_AGENT_ID)
        .cloned()
        .collect();

    // Lock scopes + seed the board straight from the dispatch.
    for (rec, m) in ic_records.iter().zip(members.iter()) {
        let scope: Vec<String> = m
            .scope
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect();
        if !scope.is_empty() {
            session.assign_scope(bus, &rec.id, scope, Vec::new())?;
        }
        session.assign_task(bus, m.task.clone(), Some(rec.id.clone()), Vec::new())?;
    }

    // The Lead briefs the team — the dispatch's own words, per member.
    let assignments = ic_records
        .iter()
        .zip(members.iter())
        .map(|(rec, m)| {
            let owned = if m.scope.is_empty() {
                "(no owned paths)".to_string()
            } else {
                m.scope.join(", ")
            };
            format!(
                "- {} [{}] (owns: {owned}):\n  {}",
                m.role,
                rec.id,
                m.task.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let brief = format!(
        "Team, here's what we're building:\n{goal}\n\nAssignments:\n{assignments}\n\nStart your assigned work now. Coordinate here with teammates as needed; mention @lead only for direction, blockers, or scope access."
    );
    bus.post(
        session.workspace(),
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::Message,
            body: brief,
            meta: Some(json!({ "phase": "working", "brief": true })),
        },
    )?;
    let _ = session.workspace().append_decision(&format!(
        "## Dispatch — {}\nGoal: {goal}\n\nAssignments:\n{assignments}\n",
        now_rfc3339()
    ));

    bus.post(
        session.workspace(),
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::System,
            body: format!(
                "Assignments locked — {} worker{} ready.",
                ic_records.len(),
                if ic_records.len() == 1 { "" } else { "s" }
            ),
            meta: Some(json!({
                "phase": "working",
                "icCount": ic_records.len()
            })),
        },
    )?;

    mark_team_planning(&session);

    session.workspace().load_state(Some(DEFAULT_CHANNEL_TAIL))
}

// ─── model-call helper ────────────────────────────────────────────────────

/// One tool-less completion: send `system` + a single `user` message and
/// return the concatenated assistant text. Streams into a drained sink so
/// the provider adapter (which must not buffer) never blocks, then reads the
/// reconstructed message the trait returns.
///
/// Shared with the integration runner ([`super::integration_runner`]) for its
/// one-shot peer-review calls.
pub(crate) async fn complete_text(
    client: &Arc<dyn StreamingApiClient>,
    model: &str,
    system: &str,
    user: &str,
    max_output_tokens: u32,
    cancel: &CancellationToken,
    streamer: Option<&TeamStreamer<'_>>,
) -> Result<String, RuntimeError> {
    let messages = [ConversationMessage::user_text(
        user,
        Utc::now().timestamp_millis(),
    )];
    let request = ApiRequest {
        model,
        system_prompt: Some(system),
        messages: &messages,
        tools: &[],
        temperature: None,
        max_output_tokens,
        thinking_enabled: false,
        thinking_budget_tokens: None,
    };

    let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
    let stream_fut = client.stream(request, tx, cancel.clone());
    // Open a live bubble for this agent before the first token arrives, so the
    // Team view shows "…thinking" immediately instead of dead air.
    if let Some(s) = streamer {
        s.start();
    }
    // Drain concurrently on the same task: the adapter pushes deltas as they
    // arrive and we must keep receiving or a full buffer would deadlock the
    // stream. Each delta is ALSO forwarded live to the Team view (parity with
    // the normal chat composer) and ACCUMULATED here, because reasoning models
    // sometimes leave the reconstructed message without a Text block even though
    // text was streamed — keeping the deltas means we don't lose the answer.
    let drain_fut = async move {
        let mut streamed_text = String::new();
        let mut streamed_thinking = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                AssistantEvent::TextDelta { delta } => {
                    if let Some(s) = streamer {
                        s.text(&delta);
                    }
                    streamed_text.push_str(&delta);
                }
                AssistantEvent::Thinking { text, .. } => {
                    if let Some(s) = streamer {
                        s.thinking(&text);
                    }
                    streamed_thinking.push_str(&text);
                }
                _ => {}
            }
        }
        (streamed_text, streamed_thinking)
    };
    // Bound the whole call: a hung provider must not strand the run forever.
    let joined = async { tokio::join!(stream_fut, drain_fut) };
    let (res, (streamed_text, streamed_thinking)) = match tokio::time::timeout(
        TEAM_MODEL_CALL_TIMEOUT,
        joined,
    )
    .await
    {
        Ok(pair) => {
            // Settle the live bubble; the authoritative post/transcript follows.
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
                    "team model call timed out after {}s (the provider connected but never completed the response)",
                    TEAM_MODEL_CALL_TIMEOUT.as_secs()
                )));
        }
    };
    let turn = res?;

    // 1. Prefer the reconstructed message's visible text blocks.
    let mut out = turn
        .assistant_message
        .blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    // 2. Fall back to the visible text we accumulated from the stream.
    if out.is_empty() {
        out = streamed_text.trim().to_string();
    }

    // 3. Last resort: the model's thinking content (a reasoning model that ran
    //    out of room for a final answer often has the JSON in here). The
    //    callers parse JSON out of noisy text, so this is still usable.
    if out.is_empty() {
        let block_thinking = turn
            .assistant_message
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Thinking { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        out = if block_thinking.trim().is_empty() {
            streamed_thinking.trim().to_string()
        } else {
            block_thinking.trim().to_string()
        };
    }

    Ok(out)
}

// ─── v2 roster integrity (P1) ───────────────────────────────────────────────

/// Is `role` a **non-builder / meta** role the team must not field as an IC?
/// Coordination, integration, review, and the gate belong to the Lead — an IC
/// is only ever a *feature builder*. Token-based so `preview-owner` is NOT
/// mistaken for a `review` role.
pub(crate) fn is_meta_role(role: &str) -> bool {
    const META: &[&str] = &[
        "lead",
        "integration",
        "integrate",
        "integrator",
        "coordinator",
        "coordination",
        "architect",
        "reviewer",
        "review",
        "verifier",
        "verification",
        "qa",
        "devops",
        "manager",
        "orchestrator",
        "gatekeeper",
        "overseer",
    ];
    let tokens: Vec<String> = role
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();

    // `<thing>-owner` is the shape `builder_role_from_scope` emits, so inside
    // that suffix a meta word is only meta when it IS the thing owned, not
    // when it merely qualifies one:
    //
    //   integration-owner   → owns "integration"        → meta
    //   review-owner        → owns "review"             → meta
    //   review-page-owner   → owns the review PAGE      → builder
    //   preview-owner       → "preview" isn't meta      → builder
    //
    // Plain token matching got the third case wrong and relabelled a real
    // builder out from under the Lead.
    if tokens.last().is_some_and(|t| t == "owner") {
        let owned = &tokens[..tokens.len() - 1];
        return owned.len() == 1 && META.contains(&owned[0].as_str());
    }

    tokens.iter().any(|t| META.contains(&t.as_str()))
}

/// Derive a concrete builder role from an agent's first real scope path, so a
/// relabelled meta role still names what it BUILDS (e.g. `src/features/account/**`
/// → `account-owner`, `src/router.tsx` → `router-owner`). Falls back to
/// `module-owner` when nothing usable can be derived.
pub(crate) fn builder_role_from_scope(scope: &[String]) -> String {
    let Some(first) = scope.iter().find(|s| !s.trim().is_empty()) else {
        return "module-owner".to_string();
    };
    let cleaned = first.replace(['*', '\\'], "/");
    let stem = cleaned
        .split('/')
        .filter(|s| !s.is_empty() && !matches!(*s, "src" | "app" | "."))
        .next_back()
        .unwrap_or("module");
    let stem = stem.split('.').next().unwrap_or("module");
    let stem: String = stem.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if stem.is_empty() {
        "module-owner".to_string()
    } else {
        format!("{}-owner", stem.to_ascii_lowercase())
    }
}

// ─── plan parsing ─────────────────────────────────────────────────────────

/// Parse the Lead's reply into a [`LeadPlan`]. Tries the whole reply first,
/// then falls back to the outermost `{…}` slice (models often wrap JSON in
/// prose or code fences despite instructions).
fn parse_lead_plan(raw: &str) -> Result<LeadPlan, RuntimeError> {
    if let Ok(plan) = serde_json::from_str::<LeadPlan>(raw) {
        return Ok(plan);
    }
    if let Some(slice) = extract_json_object(raw) {
        if let Ok(plan) = serde_json::from_str::<LeadPlan>(&slice) {
            return Ok(plan);
        }
    }
    Err(RuntimeError::InvalidState(format!(
        "the Lead did not return a parseable plan; raw output: {}",
        raw.chars().take(280).collect::<String>()
    )))
}

/// Slice out the outermost JSON object (`{` … `}`) from a noisy reply.
/// Shared with the integration runner for parsing review verdicts.
pub(crate) fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    (end > start).then(|| s[start..=end].to_string())
}

/// Small, real snapshot of the repository for the Lead's scope planner.
/// Planning without this makes the model guess path roots (`src/` vs `app/`),
/// which then traps ICs behind the scope guard.
fn planning_workspace_snapshot(repo_root: &Path) -> String {
    const MAX_DEPTH: usize = 3;
    const MAX_LINES: usize = 180;

    fn skip_dir(name: &str) -> bool {
        name.starts_with('.')
            || matches!(
                name,
                "node_modules" | "target" | "dist" | "build" | "out" | "vendor" | ".next"
            )
    }

    fn walk(root: &Path, dir: &Path, depth: usize, lines: &mut Vec<String>) {
        if depth > MAX_DEPTH || lines.len() >= MAX_LINES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| (!entry.path().is_dir(), entry.file_name()));
        for entry in entries {
            if lines.len() >= MAX_LINES {
                lines.push("...(workspace snapshot truncated)".to_string());
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() && skip_dir(&name) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                lines.push(format!("{rel}/"));
                walk(root, &path, depth + 1, lines);
            } else {
                lines.push(rel);
            }
        }
    }

    let mut lines = Vec::new();
    walk(repo_root, repo_root, 0, &mut lines);
    if lines.is_empty() {
        "(repository appears empty or could not be listed)".to_string()
    } else {
        lines.join("\n")
    }
}

// ─── prompts ──────────────────────────────────────────────────────────────

fn lead_planning_prompt(cap: usize, ic_cap: usize, desired_ics: Option<usize>) -> String {
    // The sizing rule changes when the user gave an explicit count: in that
    // case the team MUST be exactly that many ICs (no solo fallback).
    let sizing_rule = match desired_ics {
        Some(n) => format!(
            "- SIZING (EXPLICIT USER ORDER): the user asked for exactly {n} IC{plural}. You MUST output exactly {n} agent{plural} — never zero, never fewer, never more. Split the work into {n} coherent, non-overlapping slices even if you'd personally prefer fewer; if the goal is small, divide it by layer/file/feature so each of the {n} ICs has a real slice. Do NOT go solo. Hard cap is {ic_cap} ICs (you are extra), and {n} is within it.",
            plural = if n == 1 { "" } else { "s" },
        ),
        None => format!(
            "- SIZING (your judgment): keep the team only as large as the work honestly needs. Hard cap: {cap} agents INCLUDING yourself, so at most {ic_cap} ICs. Prefer fewer, but output at least one scoped builder for a dispatched team run."
        ),
    };
    format!(
        "You are the Lead engineer of an autonomous AI engineering team working inside the Aurora IDE on the user's real repository.

Right now you are running the PLANNING STANDUP. Decompose the user's goal into a team of specialist ICs (individual contributors). Give each IC a NON-OVERLAPPING slice of the repo to own, and seed each with concrete starter tasks.

Rules:
{sizing_rule}
- BUILDERS ONLY. Every IC is a feature/area builder that WRITES code. Do NOT create a \"lead\", \"lead-engineer\", \"integration-owner\", \"integrator\", \"qa\", \"tester\", \"reviewer\", \"coordinator\", \"architect\", or \"devops\" role — YOU, the Lead, run integration, peer review, and the build/lint/test gate yourself after the build. Every agent you list MUST own a concrete, non-empty slice of real files it will create or edit. A role that would only \"verify\", \"coordinate\", \"integrate\", or \"wire things together\" is forbidden — fold that work into a real builder or do it yourself.
- Name roles for THIS project after what they BUILD (e.g. \"api-owner\", \"ui-owner\", \"db-owner\"), not generic or process titles.
- Scopes MUST NOT overlap — every folder/path is owned by exactly one IC.
- KEEP COUPLED FILES TOGETHER under ONE owner. If file A imports from file B and both must change for this goal (e.g. a hook and the API module it calls), the SAME owner owns BOTH. Never split tightly-coupled files across two owners — that forces them to block on each other and the work stalls.
- Scope entries may be a folder (\"src/api/\"), a file, or a glob: `*` within a filename (\"src/components/Hero.*\" = Hero.tsx + Hero.css) and `**` across folders (\"packages/core/**\"). Make sure every file an IC must create or edit is covered by one of its scope entries.

Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{{\"stack\":\"<detected stack or empty>\",\"summary\":\"<one sentence plan summary>\",\"agents\":[{{\"role\":\"<role>\",\"scope\":[\"<path/>\"],\"tasks\":[\"<task>\"]}}]}}"
    )
}

fn ic_standup_prompt(role: &str, scope: &[String]) -> String {
    let owned = if scope.is_empty() {
        "(to be decided with the Lead)".to_string()
    } else {
        scope.join(", ")
    };
    format!(
        "You are \"{role}\", an IC on an AI engineering team in the Aurora IDE. The Lead has assigned you ownership of: {owned}.

This is the planning standup. In 1-2 sentences, acknowledge your scope and flag ONE concrete boundary concern or dependency on a teammate (or say you have none). Do NOT write code. Be terse."
    )
}

/// Render the recent team-chat tail as readable lines for IC context, so each
/// member reacts to the Lead's brief + teammates instead of talking into a
/// void. Only conversational/coordination events are included.
fn recent_discussion(session: &TeamSession, limit: usize) -> String {
    let events = match session.workspace().read_channel(Some(limit)) {
        Ok(e) => e,
        Err(_) => return "(no chat yet)".to_string(),
    };
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
    if lines.is_empty() {
        "(no chat yet)".to_string()
    } else {
        lines.join("\n")
    }
}

/// Render the locked scope partition as a readable list for IC context.
fn scope_summary(records: &[AgentRecord], planned: &[PlannedAgent]) -> String {
    if records.is_empty() {
        return "(solo — the Lead owns the whole repo)".to_string();
    }
    records
        .iter()
        .zip(planned.iter())
        .map(|(r, p)| {
            let owned = if p.scope.is_empty() {
                "(unassigned)".to_string()
            } else {
                p.scope.join(", ")
            };
            format!("- {} [{}]: {}", r.role, r.id, owned)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::TurnUsage;
    use crate::agent_runtime::team::types::TeamPhase;
    use crate::agent_runtime::team::workspace::ProjectWorkspace;
    use crate::agent_runtime::types::{MessageRole, TokenUsage};
    use async_trait::async_trait;

    /// Mock client: returns a fixed plan JSON when it sees the Lead's
    /// planning prompt, and a terse ack otherwise (the IC standup).
    struct ScriptedApi;

    #[async_trait]
    impl StreamingApiClient for ScriptedApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, crate::agent_runtime::api_client::ApiError> {
            let is_lead = request
                .system_prompt
                .map(|s| s.contains("PLANNING STANDUP"))
                .unwrap_or(false);
            let text = if is_lead {
                r#"{"stack":"rust","summary":"split api and ui","agents":[
                    {"role":"api-owner","scope":["src/api/"],"tasks":["define routes","wire handlers"]},
                    {"role":"ui-owner","scope":["src/ui/"],"tasks":["build view"]}
                ]}"#
                .to_string()
            } else {
                "Ack — I own my scope, no blockers.".to_string()
            };
            // Emit one delta so the drain path is exercised.
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: text.clone(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage {
                    role: MessageRole::Assistant,
                    blocks: vec![ContentBlock::Text { text }],
                    usage: None,
                    timestamp: 0,
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                },
            })
        }
    }

    /// Mock that mimics a REASONING model which spent its whole budget on
    /// hidden chain-of-thought: the reconstructed message has NO Text block,
    /// only a Thinking block that happens to contain the JSON plan. This is the
    /// shape that produced the empty "raw output:" planning failure in the wild.
    struct ThinkingOnlyApi;

    #[async_trait]
    impl StreamingApiClient for ThinkingOnlyApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, crate::agent_runtime::api_client::ApiError> {
            let is_lead = request
                .system_prompt
                .map(|s| s.contains("PLANNING STANDUP"))
                .unwrap_or(false);
            let thinking = if is_lead {
                r#"Let me think... {"stack":"rust","summary":"solo","agents":[{"role":"only-owner","scope":["src/"],"tasks":["do it"]}]}"#
                    .to_string()
            } else {
                "Ack.".to_string()
            };
            // Stream the thinking as Thinking deltas; emit NO TextDelta and a
            // message with only a Thinking block — no Text block at all.
            let _ = event_sink
                .send(AssistantEvent::Thinking {
                    text: thinking.clone(),
                    signature: None,
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage {
                    role: MessageRole::Assistant,
                    blocks: vec![ContentBlock::Thinking {
                        text: thinking,
                        signature: None,
                    }],
                    usage: None,
                    timestamp: 0,
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                },
            })
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        TeamSession,
        TeamBus,
        Arc<dyn StreamingApiClient>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-run", dir.path().join("pid-run"));
        ws.ensure_scaffold("/repo", None).unwrap();
        (
            dir,
            TeamSession::with_workspace(ws),
            TeamBus::headless(),
            Arc::new(ScriptedApi),
        )
    }

    fn thinking_fixture() -> (
        tempfile::TempDir,
        TeamSession,
        TeamBus,
        Arc<dyn StreamingApiClient>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-think", dir.path().join("pid-think"));
        ws.ensure_scaffold("/repo", None).unwrap();
        (
            dir,
            TeamSession::with_workspace(ws),
            TeamBus::headless(),
            Arc::new(ThinkingOnlyApi),
        )
    }

    #[test]
    fn extract_json_object_strips_prose_and_fences() {
        let raw = "Sure! Here is the plan:\n```json\n{\"agents\":[]}\n```\nThanks";
        let slice = extract_json_object(raw).unwrap();
        assert_eq!(slice, "{\"agents\":[]}");
    }

    #[test]
    fn parse_lead_plan_tolerates_wrapping_prose() {
        let raw =
            "Plan: {\"stack\":\"next.js\",\"agents\":[{\"role\":\"a\",\"scope\":[\"app/\"]}]}";
        let plan = parse_lead_plan(raw).unwrap();
        assert_eq!(plan.stack.as_deref(), Some("next.js"));
        assert_eq!(plan.agents.len(), 1);
        assert_eq!(plan.agents[0].scope, vec!["app/".to_string()]);
    }

    #[test]
    fn parse_lead_plan_rejects_garbage() {
        assert!(parse_lead_plan("no json here at all").is_err());
    }

    #[test]
    fn meta_roles_are_detected_builders_are_not() {
        // Non-builders the roster must never field as ICs.
        for r in [
            "lead-engineer",
            "integration-owner",
            "qa",
            "Code Reviewer",
            "devops",
            "tech architect",
            "project_manager",
        ] {
            assert!(is_meta_role(r), "{r} should be meta");
        }
        // Real builders — including ones that merely CONTAIN a meta substring.
        for r in [
            "api-owner",
            "auth-owner",
            "ui-owner",
            "preview-owner",
            "review-page-owner",
        ] {
            assert!(!is_meta_role(r), "{r} should be a builder");
        }
    }

    #[test]
    fn builder_role_from_scope_names_what_it_builds() {
        assert_eq!(
            builder_role_from_scope(&["src/features/account/**".into()]),
            "account-owner"
        );
        assert_eq!(
            builder_role_from_scope(&["src/router.tsx".into()]),
            "router-owner"
        );
        assert_eq!(
            builder_role_from_scope(&["package.json".into()]),
            "package-owner"
        );
        assert_eq!(builder_role_from_scope(&[]), "module-owner");
        assert_eq!(builder_role_from_scope(&["src/".into()]), "module-owner");
    }

    /// Lead plan that includes the exact junk roles the user's real run produced:
    /// a `lead-engineer` (owns config files), a `qa` (owns nothing), plus one
    /// real builder. Proves the roster ends up builders-only.
    struct MetaPlanApi;

    #[async_trait]
    impl StreamingApiClient for MetaPlanApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel: CancellationToken,
        ) -> Result<TurnUsage, crate::agent_runtime::api_client::ApiError> {
            let is_lead = request
                .system_prompt
                .map(|s| s.contains("PLANNING STANDUP"))
                .unwrap_or(false);
            let text = if is_lead {
                r#"{"agents":[
                    {"role":"lead-engineer","scope":["package.json","tsconfig.json"],"tasks":["wire build"]},
                    {"role":"auth-owner","scope":["src/auth/"],"tasks":["build auth"]},
                    {"role":"qa","scope":[],"tasks":["test everything"]}
                ]}"#
                .to_string()
            } else {
                "Ack.".to_string()
            };
            let _ = event_sink
                .send(AssistantEvent::TextDelta {
                    delta: text.clone(),
                })
                .await;
            Ok(TurnUsage {
                usage: TokenUsage::default(),
                stop_reason: "end_turn".into(),
                assistant_message: ConversationMessage {
                    role: MessageRole::Assistant,
                    blocks: vec![ContentBlock::Text { text }],
                    usage: None,
                    timestamp: 0,
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                },
            })
        }
    }

    #[tokio::test]
    async fn planning_drops_scopeless_meta_and_relabels_meta_builders() {
        let dir = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-meta", dir.path().join("pid-meta"));
        ws.ensure_scaffold("/repo", None).unwrap();
        let session = TeamSession::with_workspace(ws);
        let bus = TeamBus::headless();
        let client: Arc<dyn StreamingApiClient> = Arc::new(MetaPlanApi);

        run_planning_inner(
            &bus,
            &session,
            &client,
            "lead",
            512,
            &client,
            "team",
            512,
            dir.path(),
            "build",
            5,
            None,
        )
        .await
        .unwrap();

        let team = session.workspace().read_team().unwrap().unwrap();
        let ic_roles: Vec<String> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.role.clone())
            .collect();
        // `qa` had no scope → dropped. `lead-engineer` had scope → relabelled to
        // a builder. `auth-owner` kept. Result: builders only, no meta roles.
        assert_eq!(ic_roles.len(), 2, "scope-less meta dropped: {ic_roles:?}");
        assert!(
            ic_roles.iter().all(|r| !is_meta_role(r)),
            "no meta role survives: {ic_roles:?}"
        );
        assert!(ic_roles.iter().any(|r| r == "auth-owner"));
    }

    #[tokio::test]
    async fn planning_round_convenes_assigns_and_posts_standup() {
        let (_d, session, bus, client) = fixture();
        // Lead and team can be different clients/models; here we reuse the
        // same scripted client but distinct model labels to prove both paths.
        run_planning_inner(
            &bus,
            &session,
            &client,
            "lead-model",
            1024,
            &client,
            "team-model",
            1024,
            _d.path(),
            "build a thing",
            5,
            None,
        )
        .await
        .unwrap();

        // Roster: Lead + 2 ICs, team in Planning.
        let team = session.workspace().read_team().unwrap().unwrap();
        assert_eq!(team.agents.len(), 3);
        assert!(matches!(team.phase, TeamPhase::Planning));

        // The Lead runs on the lead model; every IC on the team model — the
        // split the per-team provider feature exists to enable.
        let lead = team.agents.iter().find(|a| a.id == LEAD_AGENT_ID).unwrap();
        assert_eq!(lead.model.as_deref(), Some("lead-model"));
        for ic in team.agents.iter().filter(|a| a.id != LEAD_AGENT_ID) {
            assert_eq!(ic.model.as_deref(), Some("team-model"));
        }

        // Scopes locked (non-overlapping), board seeded.
        let scope = session.workspace().read_scope_map().unwrap().unwrap();
        assert_eq!(scope.assignments.len(), 2);
        let board = session.workspace().read_tasks().unwrap().unwrap();
        assert_eq!(board.tasks.len(), 3); // 2 + 1

        // Standup: exactly one Message per IC, authored by the IC id; plus the
        // Lead's opening brief (a Message authored by the Lead) the ICs react to.
        let chan = session.workspace().read_channel(None).unwrap();
        let ic_msgs: Vec<_> = chan
            .iter()
            .filter(|e| matches!(e.kind, ChannelEventKind::Message) && e.author != LEAD_AGENT_ID)
            .collect();
        assert_eq!(ic_msgs.len(), 2);
        let lead_brief = chan
            .iter()
            .any(|e| matches!(e.kind, ChannelEventKind::Message) && e.author == LEAD_AGENT_ID);
        assert!(lead_brief, "the Lead briefs the team in the group chat");

        // The Lead's wrap-up is the final system event.
        let last = chan.last().unwrap();
        assert!(matches!(last.kind, ChannelEventKind::System));
        assert!(last.body.contains("Planning complete"));
    }

    #[tokio::test]
    async fn planning_survives_reasoning_model_with_no_text_block() {
        // Regression: a reasoning Lead returned only thinking (no visible text),
        // which used to fail with an empty "raw output:" plan-parse error.
        // complete_text now falls back to the thinking content, so planning
        // still convenes the team.
        let (_d, session, bus, client) = thinking_fixture();
        run_planning_inner(
            &bus,
            &session,
            &client,
            "lead-model",
            1024,
            &client,
            "team-model",
            1024,
            _d.path(),
            "build a thing",
            5,
            None,
        )
        .await
        .unwrap();

        // The JSON in the thinking block was parsed → Lead + 1 IC convened.
        let team = session.workspace().read_team().unwrap().unwrap();
        assert_eq!(team.agents.len(), 2);
        assert!(matches!(team.phase, TeamPhase::Planning));
    }

    #[tokio::test]
    async fn planning_round_clamps_team_to_max_size() {
        let (_d, session, bus, client) = fixture();
        // max_size 2 → Lead + 1 IC, even though the plan proposes 2.
        run_planning_inner(
            &bus,
            &session,
            &client,
            "lead-model",
            1024,
            &client,
            "team-model",
            1024,
            _d.path(),
            "build a thing",
            2,
            None,
        )
        .await
        .unwrap();
        let team = session.workspace().read_team().unwrap().unwrap();
        assert_eq!(team.agents.len(), 2);
        let scope = session.workspace().read_scope_map().unwrap().unwrap();
        assert_eq!(scope.assignments.len(), 1);
    }

    #[tokio::test]
    async fn explicit_desired_ics_caps_the_roster() {
        let (_d, session, bus, client) = fixture();
        // The scripted plan proposes 2 ICs, but the user explicitly asked for
        // 1 — the explicit count wins and the roster is Lead + 1 IC.
        run_planning_inner(
            &bus,
            &session,
            &client,
            "lead-model",
            1024,
            &client,
            "team-model",
            1024,
            _d.path(),
            "build a thing",
            5,
            Some(1),
        )
        .await
        .unwrap();
        let team = session.workspace().read_team().unwrap().unwrap();
        assert_eq!(team.agents.len(), 2); // Lead + exactly 1 IC
        let scope = session.workspace().read_scope_map().unwrap().unwrap();
        assert_eq!(scope.assignments.len(), 1);
    }
}
