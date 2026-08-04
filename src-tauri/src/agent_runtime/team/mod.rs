//! Aurora Agent Team — the Rust engine behind `team_dispatch`.
//!
//! The chat agent in the Agent Window **is the Lead**. It defines its team
//! in one `team_dispatch` tool call (role + task + owned paths per member);
//! this module runs that team as **real agents**:
//!
//! - [`ids`] — stable `projectId` resolution from the canonical repo path.
//! - [`types`] — typed projection of the on-disk brain documents plus the
//!   member report / run-state types.
//! - [`workspace`] — [`ProjectWorkspace`], the read/write store over
//!   `~/.aurora/projects/<projectId>/`.
//! - [`bus`] — [`TeamBus`] + [`TeamEventSink`]: channel persistence plus
//!   live broadcast in one path.
//! - [`orchestrator`] — [`TeamSession`], pure state transitions over the
//!   brain (convene / scope / board / disband / write-guard).
//! - [`mailbox`] — [`TeamComms`]: real member-to-member messaging, reply
//!   tickets, and the lead inbox (questions routed to the actual chat Lead).
//! - [`member_actor`] — one member as a full headless
//!   [`crate::agent_runtime::conversation::ConversationRuntime`] session:
//!   real tools (files + validated shell), a scope gate on every mutation,
//!   and a `report` that ends its work.
//! - [`runner`] — [`seed_dispatch`], the pure (no model call) setup of the
//!   Lead-defined roster: convene, lock scopes, seed the board, brief.
//! - [`scope_guard`] — [`evaluate_write`], the pure ownership check.
//! - [`dispatch`] — [`TeamDispatcher`], the background run engine: one
//!   actor per member, live run status with per-member states, graceful
//!   cancel, per-member reports on completion.
//!
//! Tauri commands live in `commands/team.rs`; the Tauri [`TeamEventSink`]
//! and managed-state wiring live in `lib.rs`. The whole working brain lives
//! in the `~/.aurora` files, not SQLite.

#![allow(dead_code)]

pub mod bus;
pub mod dispatch;
pub mod ids;
pub mod mailbox;
pub mod member_actor;
pub mod orchestrator;
pub mod runner;
pub mod scope_guard;
pub mod types;
pub mod workspace;

#[allow(unused_imports)]
pub use bus::TeamStreamer;
pub use bus::{TeamBus, TeamEventSink};
#[allow(unused_imports)]
pub use dispatch::{RunLifecycle, TeamDispatcher, TeamRunStatus};
pub use ids::project_id_for;
#[allow(unused_imports)]
pub use mailbox::{LeadQuestion, TeamComms};
#[allow(unused_imports)]
pub use orchestrator::{AgentSpec, ConveneRequest, TeamSession};
#[allow(unused_imports)]
pub use orchestrator::{LEAD_AGENT_ID, TEAM_SIZE_HARD_CEILING};
#[allow(unused_imports)]
pub use runner::seed_dispatch;
#[allow(unused_imports)]
pub use scope_guard::{evaluate_write, ScopeDecision};
pub use workspace::{now_rfc3339, ProjectWorkspace, DEFAULT_CHANNEL_TAIL};

#[allow(unused_imports)]
pub use types::{
    AgentRecord, AgentStatus, BoardTasks, ChannelEvent, ChannelEventKind, DispatchMember,
    GateStatus, IntegrationStatus, MemberReport, MemberRunState, ProjectMeta, ReportStatus,
    ReviewVerdict, ScopeAssignment, ScopeMap, TaskRecord, TaskStatus, TeamManifest,
    TeamProjectState, TeamStreamDelta, TEAM_SCHEMA_VERSION,
};
