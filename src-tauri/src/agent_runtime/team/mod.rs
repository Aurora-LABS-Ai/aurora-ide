//! Agent Team foundation — the shared brain + TeamBus (Phase 1).
//!
//! This module is the Rust half of the Aurora Agent Team feature
//! described in `DOCS/aurora-agent-team-ground-truth.md`. Phase 1 lands
//! **the brain and the pipes** — no agents yet:
//!
//! - [`ids`] — stable `projectId` resolution from the canonical repo
//!   path (§6).
//! - [`types`] — the typed projection of the on-disk brain documents
//!   (`project.json`, `team.json`, `scope-map.json`, channel events,
//!   board, integration status) (§6).
//! - [`workspace`] — [`ProjectWorkspace`], the read/write store over
//!   `~/.aurora/projects/<projectId>/` (§6, §12 "project workspace
//!   store").
//! - [`bus`] — [`TeamBus`] + [`TeamEventSink`], channel persistence plus
//!   live broadcast in one path (§7, §12 "TeamBus").
//! - [`orchestrator`] — [`TeamSession`], the Lead's control surface
//!   (convene / add / remove / disband / assign scope / assign task) as
//!   pure state transitions over the brain (Phase 2a, §7 Lead tools).
//! - [`runner`] — [`run_planning`], the live planning round that drives the
//!   [`TeamSession`] with real model calls (Phase 2b, §9 Planning).
//! - [`scope_guard`] — [`evaluate_write`], the pure scope write-guard that
//!   enforces the ownership partition during the parallel build (Phase 3, §8).
//! - [`build_runner`] — [`run_build`], the parallel build round: each scoped
//!   IC runs a guarded tool-calling loop that edits only its owned files
//!   (Phase 3, §9 step 3).
//! - [`integration_runner`] — [`run_integration`], the integration &
//!   peer-review gate: a round-robin review pass plus the build/lint/test gate
//!   over `integration/status.json` (Phase 4, §9 step 5, §14).
//!
//! Tauri commands that drive these live in `commands/team.rs`; the Tauri
//! [`TeamEventSink`] implementation and managed-state wiring live in
//! `lib.rs`. The whole working brain lives in the `~/.aurora` files, not
//! SQLite (§18).
//!
//! Later phases extend this module with the team loop (convene → standup
//! → integration), the scope write-guard, and per-agent session reuse.

#![allow(dead_code)]

pub mod build_runner;
pub mod bus;
pub mod dispatch;
pub mod ids;
pub mod integration_runner;
pub mod orchestrator;
pub mod runner;
pub mod scope_guard;
pub mod types;
pub mod workspace;

// Public surface re-exported at the module root so callers import through
// `crate::agent_runtime::team::{…}` without reaching into submodules.
pub use bus::{TeamBus, TeamEventSink};
// The live token streamer is consumed by the runners via `super::bus`; the
// re-export keeps it on the module's public surface without every caller
// reaching into the submodule.
#[allow(unused_imports)]
pub use bus::TeamStreamer;
pub use ids::project_id_for;
pub use orchestrator::{AgentSpec, ConveneRequest, TeamSession};
// These constants are part of the team's public API (mirrored on the
// frontend and used by later phases) but not yet referenced by other Rust
// callers, so silence the unused re-export warning.
pub use build_runner::run_build;
#[allow(unused_imports)]
pub use orchestrator::{LEAD_AGENT_ID, TEAM_SIZE_HARD_CEILING};
pub use runner::run_planning;
// The background dispatch engine (one dispatch → plan→build→integrate on a
// detached task) + its live run-status registry. Both cross IPC: the commands
// drive the dispatcher and the frontend injects the status into the Lead (§17).
#[allow(unused_imports)]
pub use dispatch::{RunLifecycle, TeamDispatcher, TeamRunStatus};
// The integration & peer-review gate (Phase 4). `GateCommands` crosses IPC.
#[allow(unused_imports)]
pub use integration_runner::{run_integration, GateCommands};
// The scope write-guard is consumed via `TeamSession::check_write` and the
// `team_check_scope` command; the free function + decision type are part of
// the public surface for the build runner and frontend mirror.
#[allow(unused_imports)]
pub use scope_guard::{evaluate_write, ScopeDecision};
pub use workspace::{now_rfc3339, ProjectWorkspace, DEFAULT_CHANNEL_TAIL};

// The brain-document types are the full public surface of the team
// module — they cross the IPC boundary (mirrored in `src/types/team.ts`)
// and are populated by the team loop in later phases. Several aren't
// referenced by Rust callers *yet* (Phase 1 only writes the empty/seed
// shapes + channel events), so silence the unused re-export rather than
// drip-feed names into this list phase by phase.
#[allow(unused_imports)]
pub use types::{
    AgentRecord, AgentStatus, BoardTasks, ChannelEvent, ChannelEventKind, DispatchMember,
    GateStatus, IntegrationStatus, ProjectMeta, ReviewVerdict, ScopeAssignment, ScopeMap,
    TaskRecord, TaskStatus, TeamManifest, TeamProjectState, TeamStreamDelta, TEAM_SCHEMA_VERSION,
};
