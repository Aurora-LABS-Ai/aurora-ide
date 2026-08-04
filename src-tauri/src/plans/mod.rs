//! Plan documents — the durable surface behind Plan mode.
//!
//! A plan is a real file in the user's workspace
//! (`.aurora/plans/<nnn>-<slug>.aurora.md`) whose steps **are** the task list.
//! The agent authors it in Plan mode, then marks each step `in_progress` /
//! `done` / `failed` while executing in Agent mode, and the Canvas renders that
//! progress live.
//!
//! Layering, leaf-first:
//!
//! - [`model`] — pure types, cursor derivation, step reconciliation, liveness.
//! - [`document`] — `.aurora.md` parse/serialise; the body round-trips exactly.
//! - [`store`] — workspace filesystem access, atomic writes, locking.
//!
//! Design notes live in `DOCS/agent-plan-canvas.md`. The two rules worth
//! repeating here:
//!
//! 1. **Prose is a document, status is structured state.** A status flip
//!    rewrites frontmatter only — never the markdown body. This is why a plan
//!    is not an append-only Canvas artifact.
//! 2. **A spinner must never lie.** An `in_progress` step is only presented as
//!    running when its `runId` matches a live run; otherwise it is interrupted.
//!    See [`model::PlanStep::is_live_under`].

pub mod document;
pub mod model;
pub mod store;
