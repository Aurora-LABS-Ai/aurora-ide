//! Aurora agent safety primitives.
//!
//! This module is the Phase-3 "safety primitives" deliverable for the
//! Rust agent migration (see `docs/plan/rust-agent-migration.md` § 5.3).
//! It is intentionally **not wired** into any tool yet — Phase 3 proper
//! integrates `validate_command` into the bash tool and
//! `resolve_within_workspace` into the file tools.
//!
//! ## Public surface
//!
//! - [`bash_validation::validate_command`] — single-entry-point bash
//!   command validator backed by the 5-stage pipeline ported verbatim
//!   from `claw-code/rust/crates/runtime/src/bash_validation.rs`.
//! - [`bash_validation::ExecutionMode`] / [`bash_validation::BashValidationError`]
//!   — types in the validator's signature.
//! - [`paths::resolve_within_workspace`] / [`paths::is_within_workspace`]
//!   — workspace-boundary path resolution with single-hop symlink safety.
//! - [`paths::PathSafetyError`] — errors returned by the resolver.

pub mod bash_validation;
pub mod paths;

// Only `paths::*` is re-exported at the short path because file tools
// import via `crate::agent_safety::{resolve_within_workspace,
// PathSafetyError, is_within_workspace}` (see
// `tools/file_workspace_search/file_exists.rs` and `mod.rs`).
// `bash_validation::*` is consumed exclusively through the long path
// (`crate::agent_safety::bash_validation::validate_command`) by the
// shell tools, so re-exporting it here only fires `unused_imports`.
pub use paths::*;
