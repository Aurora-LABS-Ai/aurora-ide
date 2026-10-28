//! What the Profile page, the Project panel and a conversation's details tab
//! show: numbers derived from the session files and the usage ledger, read
//! through the engine's registry. Written once here; the window's commands
//! (`commands/{usage,project,conversation}_stats.rs`) and
//! `host_commands::stats` both call these.

pub mod conversation;
pub mod project;
pub mod usage;
