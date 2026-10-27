//! Processes Aurora starts: job objects that own a command's whole tree,
//! and reading which children are still alive. Shared by the shell tools,
//! the terminal sessions and the command streams.
//!
//! Moved out of `commands/` (2026-10-27, `DOCS/rust-core-extraction.md`
//! Phase 1.7). `commands::process_tracking` and `commands::terminal` stay as
//! aliases of these modules.

pub mod streams;
pub mod tracking;
pub mod tree;
