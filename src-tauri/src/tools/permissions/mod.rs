//! Phase 4 permission prompter scaffolding.
//!
//! Surface owned by Sub-D. Three pieces ship here:
//!
//! 1. The [`Permitter`] trait (re-exported from
//!    [`crate::agent_runtime::tool_executor`] so callers don't have
//!    to import from two different paths).
//! 2. [`prompter::PermissionRouter`] — a `(turn_id, tool_name)` →
//!    `oneshot::Sender<bool>` table that mirrors the Phase 2.3
//!    [`crate::agent_runtime::bridge::BridgeRouter`] design.
//! 3. [`prompter::TauriPermitter`] (production) and
//!    [`prompter::MockPermitter`] (tests).
//!
//! The Tauri command that the frontend calls back into
//! (`agent_grant_permission`) lives in
//! [`crate::commands::agent_v2_permissions`] so the Tauri layer stays
//! in the `commands::*` namespace alongside its peers
//! (`agent_chat_v2`, `agent_post_tool_result`, …).
//!
//! ## Production wiring (Sub-E / parent agent's final 10%)
//!
//! ```ignore
//! let router = Arc::new(PermissionRouter::new());
//! let permitter = Arc::new(TauriPermitter::new(app_handle.clone(), router.clone()));
//! let registry = ToolRegistry::new()
//!     .with_permitter(permitter.clone());
//! // expose `router` + `permitter` to lib.rs::generate_handler! so
//! // `agent_grant_permission` can resolve the oneshot.
//! ```
//!
//! Phase 3 ships the rails only — the parent agent flips the switch.

#![allow(dead_code)]

pub mod permission_guard;
pub mod prompter;

#[cfg(not(feature = "verify_only"))]
pub mod settings_aware;

#[cfg(not(feature = "verify_only"))]
pub mod tauri_emitter;

pub use crate::agent_runtime::tool_executor::Permitter;
pub use permission_guard::PermissionGuardedExecutor;
pub use prompter::{
    permission_request_event_channel, MockPermitter, PermissionEmitter,
    PermissionRequestPayload, PermissionRouter,
};

#[cfg(not(feature = "verify_only"))]
pub use prompter::TauriPermitter;

#[cfg(not(feature = "verify_only"))]
pub use settings_aware::{DatabaseSettingsResolver, SettingsAwarePermitter, SettingsResolver};

#[cfg(not(feature = "verify_only"))]
pub use tauri_emitter::TauriPermissionEmitter;
