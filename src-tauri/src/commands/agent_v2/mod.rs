//! Tauri command surface for the Rust agent loop in [`crate::agent_runtime`].
//!
//! This module is the **only** layer that knows about both the agent
//! runtime and Tauri's IPC. Everything else stays decoupled: the runtime
//! never imports `tauri`, and `lib.rs` never imports the runtime
//! directly — it goes through the commands and the [`AgentRegistry`]
//! state object.
//!
//! ## What lives here
//!
//! 1. [`AgentRegistry`] — in-memory ownership of per-thread sessions
//!    (lazy load + cache), per-turn `CancellationToken`s, the API client
//!    factory, **and** the [`BridgeRouter`] that powers frontend tool
//!    execution.
//! 2. [`ApiFactory`] — a small dyn-trait the parent integration step
//!    plugs the real provider builder into. The `build` signature
//!    takes the full [`crate::api::ProviderConfigSnapshot`] so the
//!    adapter can read api_key / custom_headers / custom_params
//!    straight from the request payload.
//! 3. [`EventEmitter`] — a small dyn-trait that abstracts Tauri's
//!    `AppHandle::emit`. Production code uses [`TauriEmitter`]; tests
//!    use a recording mock that captures every envelope/turn-complete/
//!    turn-error/tool-pending in memory.
//! 4. [`TurnDriver`] — the testable core: takes an [`AgentChatRequest`],
//!    builds the per-turn [`RuntimeConfig`] + per-turn [`ToolRegistry`]
//!    (native Rust tools + one [`FrontendBridgeExecutor`] per bridged
//!    [`AllowedTool`]), drives one
//!    [`ConversationRuntime::run_turn`] end-to-end, forwards every
//!    [`AgentEventEnvelope`] through the emitter, persists the
//!    post-turn session as JSONL, and emits the per-turn closing event.
//! 5. Eight `#[tauri::command]` wrappers in `tauri_layer.rs`
//!    (`agent_chat_v2`, `agent_compact_thread`, `agent_cancel`,
//!    `agent_load_thread`, `agent_rewind_to_user_message`,
//!    `agent_post_tool_result`, `agent_enqueue_message`,
//!    `agent_cancel_queued_message`) — thin shims over [`TurnDriver`] /
//!    [`AgentRegistry`] / [`BridgeRouter`], plus
//!    `agent_grant_permission` in `agent_v2_permissions.rs`.
//!
//! ## Persistence layout
//!
//! The runtime owns the single source of truth for chat history.
//! Sessions live under [`crate::paths::sessions_dir()`]:
//!
//! ```text
//! <root>/sessions/{thread_id}.jsonl       # message log
//! <root>/sessions/{thread_id}.meta.json   # title + usage sidecar
//! ```
//!
//! See [`crate::agent_runtime::session_store::SessionStore`] for the
//! list/load/delete/title/usage operations the Tauri thread commands
//! delegate to. Each line is one [`ConversationMessage`] — the same
//! shape [`Session::save_to_path`] writes.
//!
//! ## Tools and permissions
//!
//! - The 41 native Rust tools are registered process-wide at startup
//!   (`register_builtin_tools` in `lib.rs`), wrapped by the
//!   permission gate (`install_permission_gate`) that consults the
//!   `tool_settings` SQLite table per call.
//! - For the duration of one turn, [`TurnDriver`] builds a
//!   **per-turn** [`ToolRegistry`] from that native set plus one
//!   [`FrontendBridgeExecutor`] per [`AllowedTool`] in
//!   [`AgentChatRequest::tools`]. The bridge round-trips through the
//!   `agent_tool_pending` event channel and the `agent_post_tool_result`
//!   command so the frontend executors (MCP, team, skills, ask_question)
//!   keep working.
//!
//! ## Cancellation contract
//!
//! - The driver creates one [`CancellationToken`] per turn, registers it
//!   in [`AgentRegistry::in_flight`] keyed by `turn_id`, and unregisters
//!   it on completion (success OR failure).
//! - `agent_cancel(turn_id)` cancels the registered token and returns
//!   whether one was found.
//! - The runtime checks the token before each API call and between API
//!   call + tool dispatch (see `agent_runtime::conversation`).
//! - The bridge executor `tokio::select!`s the same token against the
//!   oneshot wait so a mid-tool cancel returns
//!   [`crate::agent_runtime::ToolError::Cancelled`] promptly.
//! - On turn completion the driver calls
//!   [`BridgeRouter::drop_turn`] to reclaim any leftover oneshot
//!   senders (defensive: the [`PendingGuard`](crate::agent_runtime::bridge)
//!   inside the executor already handles the per-call case).

#![allow(dead_code, unexpected_cfgs)]

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use dashmap::DashMap;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::StreamingApiClient;
use crate::agent_runtime::bridge::{
    BridgeEmitter, BridgeRouter, FrontendBridgeExecutor, ToolBridgeRequest, ToolBridgeResponse,
};
use crate::agent_runtime::conversation::{ConversationRuntime, RuntimeConfig};
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::events::TurnCompletion;
use crate::agent_runtime::ipc::{
    AgentChatRequest, AgentEventEnvelope, AgentExecutionMode, AllowedTool,
};
use crate::agent_runtime::recovery::{classify_error, RecoveryHint};
use crate::agent_runtime::session::Session;
use crate::agent_runtime::session_store::SessionStore;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::agent_runtime::types::ConversationMessage;
use crate::agent_safety::bash_validation::ExecutionMode;

// ============================================================================
// API factory — dyn-trait so the real provider builder drops in unchanged
// ============================================================================

/// Builds [`StreamingApiClient`] instances on demand for a given
/// [`crate::api::ProviderConfigSnapshot`].
///
/// Stored as a trait object inside [`AgentRegistry`] so the parent
/// integration can bind the real factory (`RealApiFactory` in
/// `lib.rs`) via a one-liner adapter. Tests inject a mock
/// implementation.
///
/// Returning a `Result` lets the factory surface configuration errors
/// (unknown provider, missing API key, malformed model id, …) as
/// [`RuntimeError`] without panicking.
///
/// Phase 2.3 changes the signature from the Phase 2.2
/// `(provider_id, model)` pair to the full snapshot so the adapter
/// can read api_key / base_url / custom_headers / custom_params /
/// preset defaults straight from the request payload.
pub trait ApiFactory: Send + Sync + 'static {
    fn build(
        &self,
        config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError>;
}

// ============================================================================
// Event emitter abstraction — production path is Tauri, tests use a mock
// ============================================================================

/// Sink for the four Tauri events Phase 2.3 emits per turn.
///
/// Splitting this out behind a trait keeps [`TurnDriver`] testable
/// without dragging in the `tauri` crate. Production code uses
/// [`TauriEmitter`]; tests assert against a recording mock that captures
/// every call.
pub trait EventEmitter: Send + Sync + 'static {
    /// Emit one streamed envelope (text delta, thinking, tool use,
    /// usage, message_stop, error). Wire-channel: `"agent_event"`.
    fn emit_event(&self, envelope: &AgentEventEnvelope);

    /// Emit the per-turn completion summary. Wire-channel:
    /// `"agent_turn_complete"`. The summary already carries `turn_id`
    /// inside [`TurnCompletion`], but the trait still takes `turn_id`
    /// explicitly so error and complete have a uniform signature.
    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion);

    /// Emit a turn-level error. Wire-channel: `"agent_turn_error"`.
    /// Cancellations are emitted as errors too, with `error == "cancelled"`,
    /// so the frontend has one observable signal for "this turn is over
    /// without a clean stop".
    ///
    /// Phase 4 adds the optional `recovery_hint` parameter. When the
    /// runtime can classify the error string into a known recovery
    /// recipe (auth failure, rate limit, …), the hint is propagated to
    /// the wire payload as the camelCase `recoveryHint` field. `None`
    /// produces the same shape Phase 2.3 already shipped — the field
    /// is simply omitted.
    fn emit_turn_error(&self, turn_id: &str, error: &str, recovery_hint: Option<RecoveryHint>);

    /// Emit a frontend-bridge tool-call request. Wire-channel:
    /// `"agent_tool_pending"`. Phase 2.3 fires this when the model
    /// asks for a tool whose executor is the
    /// [`FrontendBridgeExecutor`]; the frontend reads the payload,
    /// runs the tool through the existing `agent-tool-runner.ts`
    /// pipeline, and posts the result back via
    /// `agent_post_tool_result`.
    fn emit_tool_pending(&self, request: &ToolBridgeRequest);
}

/// `BridgeEmitter` is the narrower surface the bridge module needs.
/// Every [`EventEmitter`] is automatically a [`BridgeEmitter`] —
/// blanket impl so the bridge module doesn't need to know about the
/// other event channels.
impl<E: EventEmitter + ?Sized> BridgeEmitter for E {
    fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
        EventEmitter::emit_tool_pending(self, request);
    }
}

// ── Module map ──────────────────────────────────────────────────────────
//
// Split out of one 3,238-line file. Each child does `use super::*`, which
// keeps the original import surface: a child can see its parent's private
// imports. `pub use` on the first two preserves the outside-world paths
// `commands::agent_v2::{AgentRegistry, ApiFactory, EventEmitter, TurnDriver}`.

mod registry;
#[cfg(test)]
mod tests;
mod tool_policy;
mod turn_driver;

pub use registry::*;
use tool_policy::*;
pub use turn_driver::*;

// ============================================================================
// Tauri layer — production glue. Excluded from the verify crate via the
// "verify_only" feature so the standalone test crate stays Tauri-free.
// ============================================================================

#[cfg(not(feature = "verify_only"))]
mod tauri_layer;

// Glob re-export so the `__cmd__*` companion modules generated by
// `#[tauri::command]` are visible to `tauri::generate_handler!` at the
// `commands::agent_v2::{agent_chat_v2, agent_cancel, agent_load_thread}`
// path. A named re-export only carries the user-facing function symbols
// — Tauri's handler macro needs the macro-generated companions too.
#[cfg(not(feature = "verify_only"))]
pub use tauri_layer::*;
