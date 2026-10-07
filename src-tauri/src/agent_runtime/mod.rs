//! Aurora agent runtime.
//!
//! The Rust agent runtime: wire types, in-memory session model, IPC
//! envelope shapes, error type, trait surfaces, and the agent loop
//! that replaced the TypeScript agent loop — which now survives only
//! as a thin composing façade at
//! `src/apps/agent/services/runtime/agent-service.ts`.
//!
//! ## Layout
//!
//! - [`types`] — `MessageRole`, `ContentBlock`, `ConversationMessage`,
//!   `TokenUsage`. Anthropic-style content-block model.
//! - [`session`] — In-memory `Session` struct with append/iterate/clear
//!   plus JSONL load/append/save persistence helpers.
//! - [`events`] — `AssistantEvent` enum streamed to the frontend during
//!   one assistant turn, plus `TurnCompletion` per-turn summary.
//! - [`ipc`] — `AgentChatRequest` / `AgentEventEnvelope` Tauri-facing
//!   DTOs.
//! - [`error`] — `RuntimeError` (`thiserror`-based) absorbing
//!   `ApiError`, `ToolError`, `io::Error`, and `serde_json::Error`.
//! - [`api_client`] — `StreamingApiClient` trait, `ApiRequest`,
//!   `ToolSchema`, `TurnUsage`, `ApiError`.
//! - [`tool_executor`] — `ToolExecutor` trait, `ToolContext`,
//!   `ToolError`, `ToolRegistry`.
//! - [`conversation`] — `ConversationRuntime::run_turn` agent loop.
//! - [`bridge`] — `FrontendBridgeExecutor` and `BridgeRouter` plumbing
//!   that lets the runtime delegate any advertised tool back to the
//!   Tauri frontend via a one-shot request/response channel.

// `#![allow(dead_code)]` is intentionally kept: the runtime ships a
// large public-API surface (variants of `MessageRole`, `ContentBlock`,
// `RecoveryHint`, hook-trait methods, …) that is only constructed
// through `serde` deserialisation or by downstream Tauri commands, so
// rustc's reachability analysis flags it as dead even though it is
// load-bearing at runtime. Removing this attribute would drown the
// build in false positives without exposing any real bug.
#![allow(dead_code)]

pub mod api_client;
pub mod bridge;
pub mod context_limits;
pub mod conversation;
pub(crate) mod diagnostics;
pub mod error;
pub mod events;
pub mod hooks;
pub mod ipc;
pub mod project_dir;
pub mod recovery;
pub mod session;
pub mod session_index;
pub mod session_store;
pub mod title;
pub mod tool_bridge;
pub mod tool_executor;
pub mod tool_pairing;
pub mod tool_spill;
pub mod tool_suggest;
pub mod types;

// No top-level `pub use submodule::*;` re-exports. Every internal
// caller in the workspace already imports through the long path
// (`crate::agent_runtime::api_client::ApiError`,
// `crate::agent_runtime::tool_executor::ToolExecutor`, …), and there
// is no external Rust consumer of this crate (the `cdylib` is for
// Tauri's JS bridge, not Rust callers). Adding a re-export layer
// just to silence consumers that don't exist would drag back the
// `unused_imports` warning without any benefit.
