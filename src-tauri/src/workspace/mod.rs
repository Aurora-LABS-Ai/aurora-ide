//! Workspace file work every host needs: ripgrep search today, file
//! reads/writes and directory listing next (see
//! `DOCS/rust-core-extraction.md`, Phase 1.7).
//!
//! Moved out of `commands/mod.rs`, where these were `#[tauri::command]`
//! functions the agent's tools also called directly. The commands are now
//! thin wrappers over this module, so nothing here imports `tauri`.

pub mod edit;
pub mod fs;
pub mod ripgrep;

pub use fs::{read_directory, FileEntry};

pub use ripgrep::{ripgrep_search, RipgrepSearchRequest};
