//! Sub-agents — one agent starting another to do one task.
//!
//! The parent is the conversation the user is looking at. A sub-agent is a
//! second, isolated conversation the parent started with its own prompt, its
//! own tool roster and one task; the parent either waits for the answer or
//! lets it run in the background and is told when it finishes. Everything
//! here is built from pieces the runtime already has — a child is a normal
//! [`crate::agent_runtime::session::Session`] driven by the normal turn loop,
//! journaled to its own `conversation.jsonl`, under its own cancel token.
//!
//! ## Where a child lives on disk
//!
//! Inside its parent's folder, never beside it:
//!
//! ```text
//! <project>/<parent thread>/conversation.jsonl
//! <project>/<parent thread>/agents/<agent id>/agent.json          who, what, status
//! <project>/<parent thread>/agents/<agent id>/conversation.jsonl  the child's transcript
//! <project>/<parent thread>/agents/<agent id>/meta.json           usage, title
//! ```
//!
//! That placement is the whole persistence story: the thread listing walks
//! the project folder one level deep, so children never appear as
//! conversations of their own, and deleting the parent removes them. Reopening
//! the parent ten days later finds its agents by reading `agents/`.
//!
//! ## What is where
//!
//! - [`catalog`] — agent definitions: three built-ins plus the user's own
//!   files under `~/.aurora/agents/`.
//! - [`record`] — the in-memory task registry: what each agent is doing now.
//!   Cache, not truth; the files above are the truth.
//! - [`store`] — the child store placement and the `agent.json` sidecar.
//! - [`prompt`] — the child's system prompt.
//! - [`host`] — the seam the tools call through. The tools know how to ask
//!   for a spawn; `commands::agent_v2` knows how to run one.
//! - [`events`] — the lifecycle payload the window listens to.
//!
//! ## Guarantees, and where each is enforced
//!
//! - A child never gets the spawn tools (`commands::agent_v2::tool_policy`
//!   builds a child roster from the definition's allow-list, which cannot
//!   name them). One level of delegation, enforced at roster build time.
//! - A child cannot ask the user anything: frontend-bridged tools are not in
//!   any child roster, because their replies are routed by the parent's turn
//!   id and would never arrive.
//! - A synchronous child dies with the parent's turn (its cancel token is a
//!   child of the parent's). A background child survives it and dies only by
//!   an explicit stop or the app closing.
//! - Every message a child produces is journaled before anything else sees
//!   it — the same per-message journal every conversation has.

pub mod activity;
pub mod catalog;
pub mod events;
pub mod host;
pub mod messaging;
pub mod grant;
pub mod outbox;
pub mod prompt;
pub mod rail_state;
pub mod record;
pub mod report;
pub mod store;
pub mod trailer;

pub use catalog::AgentDefinition;
pub use events::SubagentEvent;
pub use host::{ParentTurn, ProviderLookup, SubagentHost};
pub use record::TaskRegistry;

/// How long a `message_parent` call with `waitForReply` holds for the
/// parent's answer. Long enough for a busy parent to reach its next step and
/// reply; short enough that a parent that never answers costs the child two
/// minutes, not its run.
pub const WAIT_FOR_REPLY_SECS: u64 = 120;

/// Mint an agent id. Also the child's thread id and its folder name, so it
/// has to satisfy [`crate::agent_runtime::project_dir::validate_thread_id`]:
/// one filename component, ASCII letters, digits, `-` and `_` only.
#[must_use]
pub fn new_agent_id() -> String {
    format!("agent_{}", uuid::Uuid::new_v4().simple())
}

/// Mint a turn id for a child's run. Children's turns stream on the same
/// event channel as everything else, so the id must be unique across the
/// process, and it is prefixed so a log line tells a child's turn apart.
#[must_use]
pub fn new_child_turn_id() -> String {
    format!("sub_{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_are_valid_thread_ids() {
        for _ in 0..16 {
            let id = new_agent_id();
            crate::agent_runtime::project_dir::validate_thread_id(&id)
                .unwrap_or_else(|e| panic!("{id} must be a valid thread id: {e}"));
            assert!(id.starts_with("agent_"));
        }
    }
}
