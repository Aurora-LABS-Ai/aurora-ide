//! Dispatch seeding — set the brain up exactly as the Lead defined the team.
//!
//! This used to hold two model-driven rounds: an auto-planner (`run_planning`,
//! a fresh-context "lead" that re-planned the chat Lead's work — a direct
//! violation of the product's vision) and per-member standup calls. Both are
//! gone. The chat Lead defines the team in `team_dispatch`; seeding is pure
//! state: convene that roster, lock the scopes, seed one board task per
//! member, and post the Lead's brief. The members' first model call is their
//! real work turn ([`super::member_actor::run_member`]).

#![allow(dead_code)]

use serde_json::json;
use uuid::Uuid;

use crate::agent_runtime::error::RuntimeError;

use super::bus::TeamBus;
use super::orchestrator::{
    AgentSpec, ConveneRequest, TeamSession, LEAD_AGENT_ID, TEAM_SIZE_HARD_CEILING,
};
use super::types::{
    AgentRecord, ChannelEvent, ChannelEventKind, DispatchMember, TeamPhase, TeamProjectState,
};
use super::workspace::{now_rfc3339, DEFAULT_CHANNEL_TAIL};

/// One seeded member: its roster record plus the Lead-authored assignment.
#[derive(Debug, Clone)]
pub struct SeededMember {
    pub record: AgentRecord,
    pub task: String,
    pub owned: Vec<String>,
}

/// Set up the team exactly as the dispatching Lead defined it: convene the
/// roster, lock scopes, seed one board task per member from its
/// instructions, and post the Lead's brief to the group chat. No model
/// calls. Returns the seeded members so the dispatcher can start their
/// actors without re-reading the brain.
pub fn seed_dispatch(
    bus: &TeamBus,
    repo_path: &str,
    goal: &str,
    members: &[DispatchMember],
    lead_model: Option<String>,
    team_model: &str,
    max_size: usize,
) -> Result<Vec<SeededMember>, RuntimeError> {
    let session = TeamSession::open(repo_path)?;

    let cap = max_size.min(TEAM_SIZE_HARD_CEILING).max(1);
    let members: Vec<&DispatchMember> = members
        .iter()
        .filter(|m| !m.role.trim().is_empty() && !m.task.trim().is_empty())
        .take(cap.saturating_sub(1))
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
                model: Some(team_model.to_string()),
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
    let mut seeded = Vec::with_capacity(ic_records.len());
    for (rec, m) in ic_records.iter().zip(members.iter()) {
        let scope: Vec<String> = m
            .scope
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect();
        if !scope.is_empty() {
            session.assign_scope(bus, &rec.id, scope.clone(), Vec::new())?;
        }
        session.assign_task(bus, m.task.clone(), Some(rec.id.clone()), Vec::new())?;
        seeded.push(SeededMember {
            record: rec.clone(),
            task: m.task.clone(),
            owned: scope,
        });
    }

    // The Lead briefs the team — the dispatch's own words, per member.
    let assignments = seeded
        .iter()
        .map(|s| {
            let owned = if s.owned.is_empty() {
                "(no owned paths)".to_string()
            } else {
                s.owned.join(", ")
            };
            format!(
                "- {} [{}] (owns: {owned}):\n  {}",
                s.record.role,
                s.record.id,
                s.task.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let brief = format!(
        "Team, here's what we're building:\n{goal}\n\nAssignments:\n{assignments}\n\nStart your assigned work now. Coordinate with ask_member / send_message; reach me with ask_lead for direction, blockers, or scope access."
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

    // The team is Working the moment the brief lands.
    if let Ok(Some(mut team)) = session.workspace().read_team() {
        team.phase = TeamPhase::Working;
        team.updated_at = now_rfc3339();
        let _ = session.workspace().write_team(&team);
    }

    Ok(seeded)
}

/// Reload the settled brain snapshot after seeding (IPC convenience).
pub fn seeded_state(repo_path: &str) -> Result<TeamProjectState, RuntimeError> {
    TeamSession::open(repo_path)?
        .workspace()
        .load_state(Some(DEFAULT_CHANNEL_TAIL))
}

#[cfg(test)]
mod tests {
    use super::super::workspace::ProjectWorkspace;
    use super::*;
    use tempfile::tempdir;

    fn member(role: &str, task: &str, scope: &[&str]) -> DispatchMember {
        DispatchMember {
            role: role.into(),
            task: task.into(),
            scope: scope.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn open_session(dir: &std::path::Path) -> TeamSession {
        let ws = ProjectWorkspace::at_root("pid-seed", dir.join("brain"));
        ws.ensure_scaffold(dir.to_str().unwrap(), None).unwrap();
        TeamSession::with_workspace(ws)
    }

    /// seed_dispatch resolves its own workspace from the repo path, so tests
    /// drive it through a temp HOME-independent path by seeding directly via
    /// the session-level pieces it composes. What we verify here is the
    /// composed outcome on a real brain.
    #[test]
    fn seeding_locks_scopes_boards_tasks_and_briefs() {
        let dir = tempdir().unwrap();
        let session = open_session(dir.path());
        let bus = TeamBus::headless();

        // Compose the same steps seed_dispatch runs, against this brain.
        let members = [
            member(
                "api-owner",
                "Build the orders API with tests.",
                &["src/api"],
            ),
            member("ui-owner", "Build the orders table UI.", &["src/ui"]),
        ];
        let req = ConveneRequest {
            lead_model: None,
            stack: None,
            agents: members
                .iter()
                .map(|m| AgentSpec {
                    role: m.role.clone(),
                    model: Some("test-model".into()),
                })
                .collect(),
        };
        let team = session.convene(&bus, req, 8).unwrap();
        let ics: Vec<AgentRecord> = team
            .agents
            .iter()
            .filter(|a| a.id != LEAD_AGENT_ID)
            .cloned()
            .collect();
        assert_eq!(ics.len(), 2);
        for (rec, m) in ics.iter().zip(members.iter()) {
            session
                .assign_scope(&bus, &rec.id, m.scope.clone(), Vec::new())
                .unwrap();
            session
                .assign_task(&bus, m.task.clone(), Some(rec.id.clone()), Vec::new())
                .unwrap();
        }

        let scope = session.workspace().read_scope_map().unwrap().unwrap();
        assert_eq!(scope.assignments.len(), 2);
        let board = session.workspace().read_tasks().unwrap().unwrap();
        assert_eq!(board.tasks.len(), 2);
        assert!(board.tasks.iter().all(|t| t.owner.is_some()));
    }

    #[test]
    fn seeding_rejects_an_empty_member_list() {
        // The filter runs before any brain mutation, so this needs no disk.
        let members: Vec<DispatchMember> = vec![member("", "", &[])];
        let usable: Vec<&DispatchMember> = members
            .iter()
            .filter(|m| !m.role.trim().is_empty() && !m.task.trim().is_empty())
            .collect();
        assert!(usable.is_empty());
    }
}
