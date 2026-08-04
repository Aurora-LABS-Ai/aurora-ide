//! `TeamSession` — the Lead's control surface over the shared brain
//! (ground truth §7 "Lead-only team-control tools", §9 lifecycle).
//!
//! **Phase 2a: pure state transitions** on the Phase-1 brain. Every method
//! reads the relevant document(s) from the [`ProjectWorkspace`], mutates
//! them, writes back atomically, and — for lifecycle-significant changes —
//! posts a `System` event through the [`TeamBus`] so the change is
//! persisted **and** streamed to the team view in one path (no side
//! channels). There are **no model calls here**: the live planning round
//! (Phase 2b) and the build loop (Phase 3) drive these same methods.
//!
//! These are exactly the controls the Lead invokes as tools: convene, add
//! agent, remove/dismiss agent, stop/disband, (re)assign scope, assign
//! task. The Lead is special-cased: it always heads the roster and can
//! never be removed (it is the only agent that talks to the user).

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::agent_runtime::error::RuntimeError;

use super::bus::TeamBus;
use super::scope_guard::{evaluate_write, ScopeDecision};
use super::types::{
    AgentRecord, AgentStatus, BoardTasks, ChannelEvent, ChannelEventKind, IntegrationStatus,
    ScopeAssignment, ScopeMap, TaskRecord, TaskStatus, TeamManifest, TeamPhase,
};
use super::workspace::{now_rfc3339, ProjectWorkspace};

/// Hard ceiling on total team size (§11). Mirrors the frontend
/// `TEAM_SIZE_HARD_CEILING`; enforced here too so no IPC caller can field
/// a larger team than the product allows, whatever `max_size` is passed.
pub const TEAM_SIZE_HARD_CEILING: usize = 16;

/// Stable id of the Lead within a roster. The Lead heads `team.json`,
/// authors lifecycle events, talks to the user, and cannot be removed.
pub const LEAD_AGENT_ID: &str = "lead";

/// One IC the Lead wants to field. IPC-friendly (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    /// Dynamically specialized role for this project (e.g. `"app-owner"`).
    pub role: String,
    /// Provider/model id the agent runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// What the Lead decides at Convene time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConveneRequest {
    /// Model the Lead itself runs on (recorded on `project.json` + roster).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_model: Option<String>,
    /// Detected stack label for `project.json` (e.g. `"next.js"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// The IC agents to field. Clamped to the user's max (and the hard
    /// ceiling) — surplus specs are dropped.
    #[serde(default)]
    pub agents: Vec<AgentSpec>,
}

/// The Lead's control surface over one project's team brain. Cheap to
/// construct; all state lives on disk via the wrapped [`ProjectWorkspace`].
pub struct TeamSession {
    ws: ProjectWorkspace,
}

impl TeamSession {
    /// Open the brain for a repo path, scaffolding it if needed.
    pub fn open(repo_path: &str) -> Result<Self, RuntimeError> {
        let ws = ProjectWorkspace::resolve(repo_path);
        ws.ensure_scaffold(repo_path, None)?;
        Ok(Self { ws })
    }

    /// Wrap an existing workspace (used by tests and by callers that
    /// already resolved it).
    #[must_use]
    pub fn with_workspace(ws: ProjectWorkspace) -> Self {
        Self { ws }
    }

    #[must_use]
    pub fn workspace(&self) -> &ProjectWorkspace {
        &self.ws
    }

    // ── helpers ───────────────────────────────────────────────────────

    fn read_team(&self) -> Result<TeamManifest, RuntimeError> {
        self.ws
            .read_team()?
            .ok_or_else(|| RuntimeError::InvalidState("team.json missing; convene first".into()))
    }

    /// Stamp `updated_at` and persist the roster.
    fn save_team(&self, team: &mut TeamManifest) -> Result<(), RuntimeError> {
        team.updated_at = now_rfc3339();
        self.ws.write_team(team)
    }

    /// Post one event to the channel as `author` (persist + broadcast in a
    /// single path via the bus — no side channels).
    fn agent_say(
        &self,
        bus: &TeamBus,
        author: &str,
        kind: ChannelEventKind,
        body: impl Into<String>,
        meta: Option<serde_json::Value>,
    ) -> Result<ChannelEvent, RuntimeError> {
        let ev = ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: author.to_string(),
            kind,
            body: body.into(),
            meta,
        };
        bus.post(&self.ws, ev)
    }

    /// Post a lifecycle note to the channel as the Lead.
    fn lead_say(
        &self,
        bus: &TeamBus,
        body: impl Into<String>,
        meta: Option<serde_json::Value>,
    ) -> Result<ChannelEvent, RuntimeError> {
        self.agent_say(bus, LEAD_AGENT_ID, ChannelEventKind::System, body, meta)
    }

    /// Derive a readable, unique agent id from a role (`"app owner"` →
    /// `"app-owner-1a2b3c"`).
    fn gen_agent_id(role: &str) -> String {
        let slug: String = role
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let short = Uuid::new_v4().to_string();
        let stem = slug.trim_matches('-');
        let stem = if stem.is_empty() { "agent" } else { stem };
        format!("{}-{}", stem, &short[..6])
    }

    /// Effective cap: the user's max, never above the hard ceiling, never
    /// below 1 (the Lead always exists).
    fn effective_cap(max_size: usize) -> usize {
        max_size.min(TEAM_SIZE_HARD_CEILING).max(1)
    }

    // ── dispatch reset ────────────────────────────────────────────────

    /// Instantly reset the brain for a **new dispatched run** so the Team
    /// window goes live the moment the user dispatches — instead of showing
    /// the previous run's final state (old roster, "done" statuses, stale
    /// gate) while the worker agents start.
    ///
    /// Resets to a starting state with a Lead-only roster, clears the scope map,
    /// board, and gate, and posts a line announcing the new goal.
    pub fn reset_for_dispatch(&self, bus: &TeamBus, goal: &str) -> Result<(), RuntimeError> {
        let now = now_rfc3339();
        let mut team = self
            .ws
            .read_team()?
            .unwrap_or_else(|| TeamManifest::empty(self.ws.project_id(), &now));
        let lead_model = team
            .agents
            .iter()
            .find(|a| a.id == LEAD_AGENT_ID)
            .and_then(|a| a.model.clone());
        team.phase = TeamPhase::Forming;
        team.agents = vec![AgentRecord {
            id: LEAD_AGENT_ID.to_string(),
            role: "lead".to_string(),
            model: lead_model,
            status: AgentStatus::Idle,
        }];
        self.save_team(&mut team)?;
        self.ws.write_scope_map(&ScopeMap::empty(&now))?;
        self.ws.write_tasks(&BoardTasks::empty(&now))?;
        self.ws.write_status(&IntegrationStatus::empty(&now))?;
        self.lead_say(
            bus,
            format!("Team dispatched — starting worker agents for: {goal}"),
            Some(json!({ "phase": "forming", "dispatched": true })),
        )?;
        Ok(())
    }

    // ── convene ───────────────────────────────────────────────────────

    /// Assemble the team: seed the roster with the Lead + clamped ICs. The resulting roster
    /// (Lead included) never exceeds `min(max_size, TEAM_SIZE_HARD_CEILING)`.
    pub fn convene(
        &self,
        bus: &TeamBus,
        req: ConveneRequest,
        max_size: usize,
    ) -> Result<TeamManifest, RuntimeError> {
        let cap = Self::effective_cap(max_size);
        let ic_cap = cap - 1; // reserve one slot for the Lead
        let mut ics = req.agents.clone();
        ics.truncate(ic_cap);

        let mut agents = Vec::with_capacity(ics.len() + 1);
        agents.push(AgentRecord {
            id: LEAD_AGENT_ID.to_string(),
            role: "lead".to_string(),
            model: req.lead_model.clone(),
            status: AgentStatus::Idle,
        });
        for spec in &ics {
            agents.push(AgentRecord {
                id: Self::gen_agent_id(&spec.role),
                role: spec.role.clone(),
                model: spec.model.clone(),
                status: AgentStatus::Idle,
            });
        }

        let mut team = self
            .read_team()
            .unwrap_or_else(|_| TeamManifest::empty(self.ws.project_id(), now_rfc3339()));
        // Seeding the roster is still Forming — the standup and scope
        // negotiation that define `Planning` happen in the planning round,
        // which sets the phase when it completes.
        team.phase = TeamPhase::Forming;
        team.agents = agents;
        self.save_team(&mut team)?;

        // Stamp lead model / detected stack on project.json if provided.
        if req.lead_model.is_some() || req.stack.is_some() {
            if let Some(mut project) = self.ws.read_project()? {
                if let Some(m) = req.lead_model.clone() {
                    project.lead_model = Some(m);
                }
                if let Some(s) = req.stack.clone() {
                    project.stack = Some(s);
                }
                self.ws.write_project(&project)?;
            }
        }

        let roles: Vec<&str> = ics.iter().map(|a| a.role.as_str()).collect();
        self.lead_say(
            bus,
            format!(
                "Team ready — {} worker{} assigned: {}",
                ics.len(),
                if ics.len() == 1 { "" } else { "s" },
                if roles.is_empty() {
                    "solo".to_string()
                } else {
                    roles.join(", ")
                },
            ),
            Some(json!({ "phase": "forming", "icRoles": roles })),
        )?;
        Ok(team)
    }

    // ── add / remove / disband ────────────────────────────────────────

    /// Bring a new IC into the running team (rejected if it would exceed
    /// the cap — the Lead must remove someone first).
    pub fn add_agent(
        &self,
        bus: &TeamBus,
        spec: AgentSpec,
        max_size: usize,
    ) -> Result<AgentRecord, RuntimeError> {
        let cap = Self::effective_cap(max_size);
        let mut team = self.read_team()?;
        if team.agents.len() >= cap {
            return Err(RuntimeError::InvalidState(format!(
                "team is at its maximum size ({cap}); remove an agent first"
            )));
        }
        let record = AgentRecord {
            id: Self::gen_agent_id(&spec.role),
            role: spec.role.clone(),
            model: spec.model.clone(),
            status: AgentStatus::Idle,
        };
        team.agents.push(record.clone());
        self.save_team(&mut team)?;
        self.lead_say(
            bus,
            format!("Added {} to the team.", spec.role),
            Some(json!({ "agentId": record.id, "role": record.role })),
        )?;
        Ok(record)
    }

    /// Remove an IC and release everything it owned: its scope assignment
    /// is dropped and any tasks it owned are unassigned (an in-progress
    /// task falls back to Todo). The Lead cannot be removed.
    pub fn remove_agent(&self, bus: &TeamBus, agent_id: &str) -> Result<(), RuntimeError> {
        if agent_id == LEAD_AGENT_ID {
            return Err(RuntimeError::InvalidState(
                "the Lead cannot be removed from the team".into(),
            ));
        }
        let mut team = self.read_team()?;
        let role = team
            .agents
            .iter()
            .find(|a| a.id == agent_id)
            .map(|a| a.role.clone());
        let before = team.agents.len();
        team.agents.retain(|a| a.id != agent_id);
        if team.agents.len() == before {
            return Err(RuntimeError::InvalidState(format!(
                "no agent with id {agent_id}"
            )));
        }
        self.save_team(&mut team)?;

        // Release scope ownership held by the removed agent.
        if let Some(mut scope) = self.ws.read_scope_map()? {
            let had = scope.assignments.len();
            scope.assignments.retain(|s| s.agent_id != agent_id);
            if scope.assignments.len() != had {
                scope.updated_at = now_rfc3339();
                self.ws.write_scope_map(&scope)?;
            }
        }

        // Unassign any tasks the agent owned.
        if let Some(mut board) = self.ws.read_tasks()? {
            let mut changed = false;
            for t in &mut board.tasks {
                if t.owner.as_deref() == Some(agent_id) {
                    t.owner = None;
                    if matches!(t.status, TaskStatus::InProgress) {
                        t.status = TaskStatus::Todo;
                    }
                    changed = true;
                }
            }
            if changed {
                board.updated_at = now_rfc3339();
                self.ws.write_tasks(&board)?;
            }
        }

        self.lead_say(
            bus,
            format!(
                "Dismissed {} from the team; its scope was released.",
                role.as_deref().unwrap_or(agent_id)
            ),
            Some(json!({ "agentId": agent_id })),
        )?;
        Ok(())
    }

    /// Stop the whole team run: move it to [`TeamPhase::Disbanded`] and
    /// idle every IC. The brain stays on disk so the team is resumable
    /// (§15) — disband is a soft stop, not a delete.
    pub fn disband(&self, bus: &TeamBus) -> Result<(), RuntimeError> {
        let mut team = self.read_team()?;
        team.phase = TeamPhase::Disbanded;
        for a in &mut team.agents {
            if a.id != LEAD_AGENT_ID {
                a.status = AgentStatus::Idle;
            }
        }
        self.save_team(&mut team)?;
        self.lead_say(
            bus,
            "Team disbanded.",
            Some(json!({ "phase": "disbanded" })),
        )?;
        Ok(())
    }

    // ── status / scope / tasks ────────────────────────────────────────

    /// Update one agent's live status. Writes `team.json` only — status
    /// ticks are intentionally **not** posted to the channel (they would
    /// flood it); the team view reflects them on its next state read.
    pub fn set_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<(), RuntimeError> {
        let mut team = self.read_team()?;
        match team.agents.iter_mut().find(|a| a.id == agent_id) {
            Some(a) => a.status = status,
            None => {
                return Err(RuntimeError::InvalidState(format!(
                    "no agent with id {agent_id}"
                )))
            }
        }
        self.save_team(&mut team)
    }

    /// Authoritatively assign folder ownership to an agent (the Lead is
    /// the tiebreaker, §8). Any path moving to this agent is stripped from
    /// every other agent so the partition stays non-overlapping by
    /// construction; owners left with nothing are dropped.
    pub fn assign_scope(
        &self,
        bus: &TeamBus,
        agent_id: &str,
        owned_paths: Vec<String>,
        owned_contracts: Vec<String>,
    ) -> Result<ScopeMap, RuntimeError> {
        let team = self.read_team()?;
        if !team.agents.iter().any(|a| a.id == agent_id) {
            return Err(RuntimeError::InvalidState(format!(
                "no agent with id {agent_id}"
            )));
        }

        let mut scope = self
            .ws
            .read_scope_map()?
            .unwrap_or_else(|| ScopeMap::empty(now_rfc3339()));

        // Take the claimed paths away from any other current owner.
        for assignment in &mut scope.assignments {
            if assignment.agent_id != agent_id {
                assignment.owned_paths.retain(|p| !owned_paths.contains(p));
            }
        }
        // Upsert this agent's assignment.
        match scope
            .assignments
            .iter_mut()
            .find(|s| s.agent_id == agent_id)
        {
            Some(existing) => {
                existing.owned_paths = owned_paths.clone();
                existing.owned_contracts = owned_contracts.clone();
            }
            None => scope.assignments.push(ScopeAssignment {
                agent_id: agent_id.to_string(),
                owned_paths: owned_paths.clone(),
                owned_contracts: owned_contracts.clone(),
            }),
        }
        // Drop owners stripped of everything.
        scope
            .assignments
            .retain(|s| !s.owned_paths.is_empty() || !s.owned_contracts.is_empty());
        scope.updated_at = now_rfc3339();
        self.ws.write_scope_map(&scope)?;

        self.lead_say(
            bus,
            if owned_paths.is_empty() {
                format!("Cleared {agent_id}'s scope.")
            } else {
                format!("Assigned {} to {}.", owned_paths.join(", "), agent_id)
            },
            Some(json!({ "agentId": agent_id, "ownedPaths": owned_paths })),
        )?;
        Ok(scope)
    }

    /// Push a ticket onto the board for an owner (or unassigned).
    pub fn assign_task(
        &self,
        bus: &TeamBus,
        title: String,
        owner: Option<String>,
        depends_on: Vec<String>,
    ) -> Result<TaskRecord, RuntimeError> {
        let mut board = self
            .ws
            .read_tasks()?
            .unwrap_or_else(|| BoardTasks::empty(now_rfc3339()));
        let task = TaskRecord {
            id: Uuid::new_v4().to_string(),
            title: title.clone(),
            owner: owner.clone(),
            status: TaskStatus::Todo,
            depends_on,
        };
        board.tasks.push(task.clone());
        board.updated_at = now_rfc3339();
        self.ws.write_tasks(&board)?;
        self.lead_say(
            bus,
            match &owner {
                Some(o) => format!("New task for {o}: {title}"),
                None => format!("New unassigned task: {title}"),
            },
            Some(json!({ "taskId": task.id, "owner": owner })),
        )?;
        Ok(task)
    }

    /// Update a task's status (no channel post — board reads pick it up).
    pub fn set_task_status(&self, task_id: &str, status: TaskStatus) -> Result<(), RuntimeError> {
        let mut board = self
            .ws
            .read_tasks()?
            .ok_or_else(|| RuntimeError::InvalidState("board/tasks.json missing".into()))?;
        match board.tasks.iter_mut().find(|t| t.id == task_id) {
            Some(t) => t.status = status,
            None => {
                return Err(RuntimeError::InvalidState(format!(
                    "no task with id {task_id}"
                )))
            }
        }
        board.updated_at = now_rfc3339();
        self.ws.write_tasks(&board)
    }

    // ── work phase ────────────────────────────────────────────────────

    /// Ask the scope write-guard whether `agent_id` may write `path`,
    /// against the current ownership partition (§8). Read-only — this is
    /// the check the build runner runs before letting an IC's file write
    /// land, and the team view uses to explain a refused edit.
    pub fn check_write(&self, agent_id: &str, path: &str) -> Result<ScopeDecision, RuntimeError> {
        let scope = self
            .ws
            .read_scope_map()?
            .unwrap_or_else(|| ScopeMap::empty(now_rfc3339()));
        Ok(evaluate_write(&scope, agent_id, path))
    }

    /// Raise a boundary question from one agent to the owner of a scope it
    /// needs to cross (§8 "boundary handling"). Persisted on the shared
    /// channel as a [`ChannelEventKind::BoundaryQuestion`] so the whole team
    /// (and the UI) sees the lateral ask. Both ids must be on the roster.
    pub fn ask_boundary(
        &self,
        bus: &TeamBus,
        from_agent: &str,
        to_owner: &str,
        question: &str,
    ) -> Result<ChannelEvent, RuntimeError> {
        let team = self.read_team()?;
        for id in [from_agent, to_owner] {
            if id != LEAD_AGENT_ID && !team.agents.iter().any(|a| a.id == id) {
                return Err(RuntimeError::InvalidState(format!("no agent with id {id}")));
            }
        }
        self.agent_say(
            bus,
            from_agent,
            ChannelEventKind::BoundaryQuestion,
            format!("@{to_owner} {question}"),
            Some(json!({ "to": to_owner })),
        )
    }

    /// Publish a shared interface other agents can depend on without
    /// crossing into the author's scope (§8 "published contract"). Records
    /// the contract under the author's `owned_contracts` in `scope-map.json`
    /// and posts a [`ChannelEventKind::ContractPublished`] to the channel.
    pub fn publish_contract(
        &self,
        bus: &TeamBus,
        agent_id: &str,
        name: &str,
        body: &str,
    ) -> Result<ChannelEvent, RuntimeError> {
        let team = self.read_team()?;
        if agent_id != LEAD_AGENT_ID && !team.agents.iter().any(|a| a.id == agent_id) {
            return Err(RuntimeError::InvalidState(format!(
                "no agent with id {agent_id}"
            )));
        }

        let mut scope = self
            .ws
            .read_scope_map()?
            .unwrap_or_else(|| ScopeMap::empty(now_rfc3339()));
        match scope
            .assignments
            .iter_mut()
            .find(|a| a.agent_id == agent_id)
        {
            Some(existing) => {
                if !existing.owned_contracts.iter().any(|c| c == name) {
                    existing.owned_contracts.push(name.to_string());
                }
            }
            None => scope.assignments.push(ScopeAssignment {
                agent_id: agent_id.to_string(),
                owned_paths: Vec::new(),
                owned_contracts: vec![name.to_string()],
            }),
        }
        scope.updated_at = now_rfc3339();
        self.ws.write_scope_map(&scope)?;

        // Persist the contract BODY as an artifact under `board/contracts/` so
        // dependents can read the real interface (§6/§8), not just its name.
        self.ws.write_contract(name, body)?;

        self.agent_say(
            bus,
            agent_id,
            ChannelEventKind::ContractPublished,
            format!("Published contract '{name}': {body}"),
            Some(json!({ "contract": name })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> (tempfile::TempDir, TeamSession, TeamBus) {
        let dir = tempfile::tempdir().unwrap();
        let ws = ProjectWorkspace::at_root("pid-orch", dir.path().join("pid-orch"));
        ws.ensure_scaffold("/repo", None).unwrap();
        (dir, TeamSession::with_workspace(ws), TeamBus::headless())
    }

    fn specs(roles: &[&str]) -> Vec<AgentSpec> {
        roles
            .iter()
            .map(|r| AgentSpec {
                role: (*r).into(),
                model: None,
            })
            .collect()
    }

    fn req(roles: &[&str]) -> ConveneRequest {
        ConveneRequest {
            lead_model: None,
            stack: None,
            agents: specs(roles),
        }
    }

    fn ic_ids(team: &TeamManifest) -> Vec<String> {
        team.agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .map(|a| a.id.clone())
            .collect()
    }

    #[test]
    fn convene_clamps_total_to_max_including_lead() {
        let (_d, s, bus) = session();
        // max 3 → Lead + 2 ICs, even though 4 were requested.
        let team = s
            .convene(
                &bus,
                ConveneRequest {
                    lead_model: Some("m".into()),
                    stack: Some("next.js".into()),
                    agents: specs(&["a", "b", "c", "d"]),
                },
                3,
            )
            .unwrap();
        assert_eq!(team.agents.len(), 3);
        assert_eq!(team.agents[0].id, LEAD_AGENT_ID);
        assert!(matches!(team.phase, TeamPhase::Forming));

        let project = s.workspace().read_project().unwrap().unwrap();
        assert_eq!(project.stack.as_deref(), Some("next.js"));
        assert_eq!(project.lead_model.as_deref(), Some("m"));
        // Convene posted exactly one lifecycle event.
        assert_eq!(s.workspace().read_channel(None).unwrap().len(), 1);
    }

    #[test]
    fn convene_respects_hard_ceiling() {
        let (_d, s, bus) = session();
        let roles: Vec<&str> = std::iter::repeat("ic").take(40).collect();
        let team = s.convene(&bus, req(&roles), 999).unwrap();
        assert_eq!(team.agents.len(), TEAM_SIZE_HARD_CEILING);
    }

    #[test]
    fn add_agent_enforces_cap() {
        let (_d, s, bus) = session();
        s.convene(&bus, req(&["a", "b"]), 3).unwrap(); // lead + 2 = cap reached
        let err = s
            .add_agent(
                &bus,
                AgentSpec {
                    role: "c".into(),
                    model: None,
                },
                3,
            )
            .unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidState(_)));
    }

    #[test]
    fn remove_agent_releases_scope_and_tasks() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["app"]), 5).unwrap();
        let ic = ic_ids(&team)[0].clone();
        s.assign_scope(&bus, &ic, vec!["app/".into()], vec![])
            .unwrap();
        let task = s
            .assign_task(&bus, "wire routes".into(), Some(ic.clone()), vec![])
            .unwrap();
        s.set_task_status(&task.id, TaskStatus::InProgress).unwrap();

        s.remove_agent(&bus, &ic).unwrap();

        let team = s.workspace().read_team().unwrap().unwrap();
        assert_eq!(team.agents.len(), 1, "only the Lead remains");
        assert!(s
            .workspace()
            .read_scope_map()
            .unwrap()
            .unwrap()
            .assignments
            .is_empty());
        let board = s.workspace().read_tasks().unwrap().unwrap();
        assert_eq!(board.tasks[0].owner, None);
        assert!(matches!(board.tasks[0].status, TaskStatus::Todo));
    }

    #[test]
    fn cannot_remove_lead() {
        let (_d, s, bus) = session();
        s.convene(&bus, req(&[]), 5).unwrap();
        assert!(s.remove_agent(&bus, LEAD_AGENT_ID).is_err());
    }

    #[test]
    fn assign_scope_keeps_partition_non_overlapping() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["a", "b"]), 5).unwrap();
        let ids = ic_ids(&team);
        s.assign_scope(&bus, &ids[0], vec!["lib/".into(), "shared/".into()], vec![])
            .unwrap();
        // Second agent claims shared/ → it is taken from the first.
        s.assign_scope(&bus, &ids[1], vec!["shared/".into()], vec![])
            .unwrap();
        let scope = s.workspace().read_scope_map().unwrap().unwrap();
        let first = scope
            .assignments
            .iter()
            .find(|x| x.agent_id == ids[0])
            .unwrap();
        assert_eq!(first.owned_paths, vec!["lib/".to_string()]);
        let second = scope
            .assignments
            .iter()
            .find(|x| x.agent_id == ids[1])
            .unwrap();
        assert_eq!(second.owned_paths, vec!["shared/".to_string()]);
    }

    #[test]
    fn disband_sets_phase_and_idles_ics() {
        let (_d, s, bus) = session();
        s.convene(&bus, req(&["a"]), 5).unwrap();
        s.disband(&bus).unwrap();
        let team = s.workspace().read_team().unwrap().unwrap();
        assert!(matches!(team.phase, TeamPhase::Disbanded));
        assert!(team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .all(|a| matches!(a.status, AgentStatus::Idle)));
    }

    #[test]
    fn set_agent_status_does_not_post_to_channel() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["a"]), 5).unwrap();
        let ic = ic_ids(&team)[0].clone();
        let before = s.workspace().read_channel(None).unwrap().len();
        s.set_agent_status(&ic, AgentStatus::Working).unwrap();
        let after = s.workspace().read_channel(None).unwrap().len();
        assert_eq!(before, after, "status ticks must not flood the channel");
        let team = s.workspace().read_team().unwrap().unwrap();
        assert!(team
            .agents
            .iter()
            .any(|a| a.id == ic && matches!(a.status, AgentStatus::Working)));
    }

    #[test]
    fn check_write_enforces_owned_scope() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["app", "lib"]), 5).unwrap();
        let ids = ic_ids(&team);
        s.assign_scope(&bus, &ids[0], vec!["app/".into()], vec![])
            .unwrap();
        s.assign_scope(&bus, &ids[1], vec!["lib/".into()], vec![])
            .unwrap();

        assert!(s.check_write(&ids[0], "app/page.tsx").unwrap().allowed);
        let cross = s.check_write(&ids[0], "lib/db.ts").unwrap();
        assert!(!cross.allowed);
        assert_eq!(cross.blocking_owner.as_deref(), Some(ids[1].as_str()));
    }

    #[test]
    fn ask_boundary_posts_question_to_owner() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["app", "lib"]), 5).unwrap();
        let ids = ic_ids(&team);
        let ev = s
            .ask_boundary(&bus, &ids[0], &ids[1], "can you export the User type?")
            .unwrap();
        assert!(matches!(ev.kind, ChannelEventKind::BoundaryQuestion));
        assert_eq!(ev.author, ids[0]);
        assert!(ev.body.contains(&ids[1]));
    }

    #[test]
    fn ask_boundary_rejects_unknown_agent() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["app"]), 5).unwrap();
        let ic = ic_ids(&team)[0].clone();
        assert!(s.ask_boundary(&bus, &ic, "ghost", "hi").is_err());
    }

    #[test]
    fn publish_contract_records_on_scope_and_channel() {
        let (_d, s, bus) = session();
        let team = s.convene(&bus, req(&["lib"]), 5).unwrap();
        let ic = ic_ids(&team)[0].clone();
        s.assign_scope(&bus, &ic, vec!["lib/".into()], vec![])
            .unwrap();

        let ev = s
            .publish_contract(&bus, &ic, "UserDTO", "{ id: string; name: string }")
            .unwrap();
        assert!(matches!(ev.kind, ChannelEventKind::ContractPublished));

        let scope = s.workspace().read_scope_map().unwrap().unwrap();
        let mine = scope.assignments.iter().find(|a| a.agent_id == ic).unwrap();
        assert!(mine.owned_contracts.iter().any(|c| c == "UserDTO"));
    }
}
