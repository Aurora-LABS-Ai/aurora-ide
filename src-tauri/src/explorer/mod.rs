//! Rust-owned explorer state and commands.

#[cfg(feature = "desktop")]
pub mod commands;
pub mod file_list;
pub mod ops;
pub mod service;
pub mod state;
pub mod types;

pub use state::ExplorerStateHandle;
