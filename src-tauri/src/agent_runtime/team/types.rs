//! Serde types for the Agent Team **shared brain** on disk.
//!
//! These structs are the typed projection of the files described in
//! `DOCS/aurora-agent-team-ground-truth.md` §6 — the
//! `~/.aurora/projects/<projectId>/` workspace. Every field maps 1:1 to
//! a key in one of the brain's JSON files so the on-disk format stays
//! human-inspectable (a real team coordinates around shared artifacts,
//! not opaque blobs).
//!
//! All wire shapes are `camelCase` because the same types cross the
//! Tauri IPC boundary to the TypeScript frontend (`src/types/team.ts`).
//! The channel log (`events.jsonl`) is the one append-only stream; the
//! rest are whole-file read/replace documents.
//!
//! Phase 1 (foundation) only constructs the empty/seed shapes and the
//! channel events; roster/scope/board population lands in Phase 2+.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Bumped whenever the on-disk brain layout changes incompatibly. Every
/// top-level document carries it so a future migration can detect old
/// workspaces.
pub const TEAM_SCHEMA_VERSION: u32 = 1;

// ─── project.json ─────────────────────────────────────────────────────

/// `project.json` — identity of one opened project's team brain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    /// Stable id derived from the canonical repo path (see
    /// [`super::ids::project_id_for`]).
    pub project_id: String,
    /// Absolute path of the user's repo this team works on.
    pub repo_path: String,
    /// Detected stack label (e.g. `"next.js"`). Filled in at Convene
    /// time (Phase 2); `None` until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// RFC-3339 timestamp the workspace was first created.
    pub created_at: String,
    /// Model the Lead runs on, recorded for replay/telemetry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_model: Option<String>,
    pub schema_version: u32,
}

// ─── team_dispatch input ──────────────────────────────────────────────

/// One member as the dispatching agent defines it in the `team_dispatch`
/// tool call: a role name, its instructions (what to build), and the paths
/// it owns. When a dispatch carries these, the engine convenes exactly this
/// roster — no separate planning model call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchMember {
    /// Role name, e.g. `"widgets-owner"`.
    pub role: String,
    /// Full instructions for this member — what to build and how.
    pub task: String,
    /// Folders/files/globs this member owns (its writable scope).
    #[serde(default)]
    pub scope: Vec<String>,
}

// ─── member reports (the real "done" signal) ──────────────────────────

/// How a member said its assignment ended. This is the member's own
/// statement via its `report` tool — not an inference from file counts.
/// An investigate-only member that changed zero files and reported findings
/// is `done`; a member that couldn't proceed says `blocked` and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Done,
    Blocked,
    /// Engine-assigned when the member never filed a report (crashed,
    /// cancelled, or went silent) — never chosen by the member itself.
    Failed,
}

/// One member's final report back to the Lead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberReport {
    pub agent_id: String,
    pub role: String,
    pub status: ReportStatus,
    /// The member's own words: what it did, what it found, what's left.
    pub summary: String,
    /// Repo-relative paths the engine actually saw this member change
    /// (recorded by the scope gate — authoritative, not self-reported).
    #[serde(default)]
    pub changed_files: Vec<String>,
}

/// Live per-member entry inside the run status — who is working, who is
/// waiting on the Lead, who finished. Gives `team_status` a real picture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRunState {
    pub id: String,
    pub role: String,
    pub status: AgentStatus,
    pub changed_count: usize,
}

// ─── team.json ────────────────────────────────────────────────────────

/// Live status of one agent, surfaced in the visible team view (§13).
///
/// Mirrors a real teammate's day: `working` at their desk, `waiting_input`
/// when they asked the boss and are blocked on the answer, `done`/`blocked`
/// as *their own* report, `failed` when their engine died. Old brains wrote
/// `planning`/`building`/`reviewing` — those deserialize as [`Self::Working`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    /// Actively executing (was `planning`/`building`/`reviewing`).
    #[serde(alias = "planning", alias = "building", alias = "reviewing")]
    Working,
    /// Paused on a question routed to the real Lead (A2A `input-required`).
    WaitingInput,
    /// Reported blocked: it could not complete its assignment and said why.
    Blocked,
    /// Its engine errored — distinct from an honest `blocked` self-report.
    Failed,
    Done,
}

impl Default for AgentStatus {
    fn default() -> Self {
        Self::Idle
    }
}

/// One roster entry in `team.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    /// Opaque agent id, unique within the team.
    pub id: String,
    /// Dynamically specialized role for this project (e.g.
    /// `"app-owner"`). Not hard-coded — the Lead proposes it (§10).
    pub role: String,
    /// Provider/model identifier the agent runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: AgentStatus,
}

/// Team-level lifecycle phase — the **whole team's** place in the
/// engineer-team flow (§9), surfaced as the headline state in the visible
/// team view. Distinct from the per-agent [`AgentStatus`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPhase {
    /// Roster not yet assembled.
    Forming,
    /// Members are executing their assignments (the old three-phase
    /// `planning`/`building`/`integrating` march collapsed into the one
    /// phase that actually happens; old brains still deserialize).
    #[serde(alias = "planning", alias = "building", alias = "integrating")]
    Working,
    /// Every member reached a terminal state and reported.
    Done,
    /// Stopped by the Lead (or the user) before completion.
    Disbanded,
}

impl Default for TeamPhase {
    fn default() -> Self {
        Self::Forming
    }
}

/// `team.json` — the roster (Lead + IC agents) for one project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    pub project_id: String,
    /// Where the whole team is in its lifecycle (§9). `#[serde(default)]`
    /// so brains written before this field existed still deserialize.
    #[serde(default)]
    pub phase: TeamPhase,
    pub agents: Vec<AgentRecord>,
    pub updated_at: String,
    pub schema_version: u32,
}

impl TeamManifest {
    #[must_use]
    pub fn empty(project_id: impl Into<String>, now: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            phase: TeamPhase::Forming,
            agents: Vec::new(),
            updated_at: now.into(),
            schema_version: TEAM_SCHEMA_VERSION,
        }
    }
}

// ─── scope-map.json ───────────────────────────────────────────────────

/// One agent's ownership claim: the folders/globs it edits and the
/// contracts it publishes. **No two assignments may own the same
/// path** (§8) — enforced by the negotiation + Lead ratification, and
/// later by the scope write-guard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeAssignment {
    pub agent_id: String,
    pub owned_paths: Vec<String>,
    #[serde(default)]
    pub owned_contracts: Vec<String>,
}

/// `scope-map.json` — the ownership partition over the repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeMap {
    pub assignments: Vec<ScopeAssignment>,
    pub updated_at: String,
}

impl ScopeMap {
    #[must_use]
    pub fn empty(now: impl Into<String>) -> Self {
        Self {
            assignments: Vec::new(),
            updated_at: now.into(),
        }
    }
}

// ─── channel/events.jsonl ─────────────────────────────────────────────

/// The kind of a team-channel event. These map directly to the
/// team-level tools that *are* the lateral arrows of the diagram (§7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelEventKind {
    /// Standup talk to the whole team.
    Message,
    /// "I'll take `app/`" → also reflected in `scope-map.json`.
    ScopeClaim,
    /// A boundary question raised to a specific owner.
    BoundaryQuestion,
    /// A shared interface pinned for dependents.
    ContractPublished,
    /// A verdict on a peer's work before integration.
    ReviewVerdict,
    /// Lifecycle/system note (convene, ratify, gate result, …).
    System,
}

/// A peer-review verdict on another agent's work before integration
/// (§7 "review a peer", §9 step 5). Carried in a [`ChannelEventKind::ReviewVerdict`]
/// event's `meta` and persisted in the `integration/reviews/` thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    /// The work looks good to integrate.
    Approve,
    /// The reviewer wants changes before integration.
    ChangesRequested,
}

/// One line of `channel/events.jsonl` — the append-only team standup.
///
/// Everything an agent does to the shared brain flows through the
/// TeamBus as one of these so it is persisted **and** streamed to the
/// UI in a single path (no side channels).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEvent {
    /// UUIDv4, unique per event.
    pub id: String,
    /// RFC-3339 timestamp the event was posted.
    pub ts: String,
    /// Author id: an agent id, `"lead"`, or `"system"`.
    pub author: String,
    pub kind: ChannelEventKind,
    /// Human-readable body of the post.
    pub body: String,
    /// Optional structured payload (e.g. claimed paths, contract name,
    /// review target + verdict). Free-form so each kind can carry what
    /// it needs without a new schema per kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

// ─── team_stream (ephemeral live token broadcast) ─────────────────────

/// A single live token-stream frame, broadcast on the `"team_stream"` channel
/// while an agent's model call is in flight.
///
/// **Ephemeral, never persisted.** Unlike a [`ChannelEvent`] (the durable
/// source of truth appended to `channel/events.jsonl`), these carry the model's
/// tokens *as they arrive* so the Team view streams in real time — exactly like
/// the normal chat composer. The authoritative content still lands afterward as
/// a posted [`ChannelEvent`] (group phases) or the agent's `session.jsonl`
/// transcript (build); the UI drops the live draft once that arrives. Dropping
/// one of these frames is purely cosmetic, so broadcast is best-effort.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStreamDelta {
    /// The agent producing the tokens: an IC id or `"lead"`.
    pub agent_id: String,
    /// Phase the tokens belong to: `"planning" | "building" | "integrating"`.
    pub phase: String,
    /// Which stream this is: `"text"` (visible answer) or `"thinking"`.
    pub kind: String,
    /// Frame type: `"start" | "delta" | "end"`.
    pub event: String,
    /// The token chunk (empty for `start`/`end` boundary frames).
    pub delta: String,
    /// The dispatch run this belongs to, so the UI can scope to the live run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Monotonic per-streamer sequence for ordering safety.
    pub seq: u64,
}

// ─── board/tasks.json ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Blocked,
    Done,
}

impl Default for TaskStatus {
    fn default() -> Self {
        Self::Todo
    }
}

/// One ticket on the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// `board/tasks.json` — the team's ticket board.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTasks {
    pub tasks: Vec<TaskRecord>,
    pub updated_at: String,
}

impl BoardTasks {
    #[must_use]
    pub fn empty(now: impl Into<String>) -> Self {
        Self {
            tasks: Vec::new(),
            updated_at: now.into(),
        }
    }
}

// ─── integration/status.json ──────────────────────────────────────────

/// Result of one gate (build / lint / test) before "done" (§14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Unknown,
    Pending,
    Passed,
    Failed,
}

impl Default for GateStatus {
    fn default() -> Self {
        Self::Unknown
    }
}

/// `integration/status.json` — the integration gate snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub build: GateStatus,
    pub lint: GateStatus,
    pub test: GateStatus,
    pub updated_at: String,
}

impl IntegrationStatus {
    #[must_use]
    pub fn empty(now: impl Into<String>) -> Self {
        Self {
            build: GateStatus::Unknown,
            lint: GateStatus::Unknown,
            test: GateStatus::Unknown,
            updated_at: now.into(),
        }
    }
}

// ─── aggregate snapshot ───────────────────────────────────────────────

/// One read of the entire brain, returned to the frontend by
/// `team_get_state` / `team_init`. The visible team view (§13) is a
/// pure renderer over this snapshot plus the live `team_event` stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamProjectState {
    pub project_id: String,
    /// `true` once the workspace has been scaffolded on disk.
    pub initialized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectMeta>,
    pub team: TeamManifest,
    pub scope_map: ScopeMap,
    pub tasks: BoardTasks,
    pub integration: IntegrationStatus,
    /// Tail of the channel (most recent events, oldest-first).
    pub channel: Vec<ChannelEvent>,
}

impl TeamProjectState {
    /// An empty, uninitialized snapshot for a project with no brain on
    /// disk yet. Lets `team_get_state` answer before `team_init`.
    #[must_use]
    pub fn uninitialized(
        project_id: impl Into<String> + Clone,
        now: impl Into<String> + Clone,
    ) -> Self {
        let id = project_id.clone().into();
        Self {
            project_id: id.clone(),
            initialized: false,
            project: None,
            team: TeamManifest::empty(id, now.clone()),
            scope_map: ScopeMap::empty(now.clone()),
            tasks: BoardTasks::empty(now.clone()),
            integration: IntegrationStatus::empty(now),
            channel: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_event_round_trips_camel_case() {
        let ev = ChannelEvent {
            id: "e1".into(),
            ts: "2026-01-01T00:00:00Z".into(),
            author: "agent-a".into(),
            kind: ChannelEventKind::ScopeClaim,
            body: "I'll take app/".into(),
            meta: Some(serde_json::json!({ "ownedPaths": ["app/"] })),
        };
        let s = serde_json::to_string(&ev).expect("serialize");
        assert!(s.contains("\"kind\":\"scope_claim\""), "got: {s}");
        let back: ChannelEvent = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back.id, "e1");
        assert!(matches!(back.kind, ChannelEventKind::ScopeClaim));
    }

    #[test]
    fn agent_status_serializes_snake_case() {
        let s = serde_json::to_string(&AgentStatus::Working).unwrap();
        assert_eq!(s, "\"working\"");
        // Old brains wrote the three-phase names — they must still load.
        for legacy in ["\"planning\"", "\"building\"", "\"reviewing\""] {
            let back: AgentStatus = serde_json::from_str(legacy).unwrap();
            assert!(matches!(back, AgentStatus::Working), "{legacy}");
        }
        let phase: TeamPhase = serde_json::from_str("\"integrating\"").unwrap();
        assert!(matches!(phase, TeamPhase::Working));
    }

    #[test]
    fn uninitialized_state_has_empty_documents() {
        let state = TeamProjectState::uninitialized("pid", "2026-01-01T00:00:00Z");
        assert!(!state.initialized);
        assert!(state.project.is_none());
        assert!(state.team.agents.is_empty());
        assert!(state.scope_map.assignments.is_empty());
        assert!(state.channel.is_empty());
        assert_eq!(state.team.schema_version, TEAM_SCHEMA_VERSION);
    }

    #[test]
    fn empty_constructors_stamp_updated_at() {
        let now = "2026-02-02T02:02:02Z";
        assert_eq!(ScopeMap::empty(now).updated_at, now);
        assert_eq!(BoardTasks::empty(now).updated_at, now);
        assert_eq!(IntegrationStatus::empty(now).updated_at, now);
    }
}
