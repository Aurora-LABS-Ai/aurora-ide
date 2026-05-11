//! Aurora agent runtime — Phase 2.1.
//!
//! This module defines the wire types, in-memory session model, IPC
//! envelope shapes, error type, **and** the trait surfaces + agent
//! loop for the Rust agent runtime that replaces the TypeScript agent
//! loop in `src/services/agent-service.ts`.
//!
//! ## Phase status
//!
//! Phase 1 (types-only) and Phase 2.1 (trait surfaces + agent loop
//! skeleton + JSONL persistence) have landed. Phase 2.2 will plug the
//! existing `provider_kernel` behind [`api_client::StreamingApiClient`]
//! and add the `agent_chat_v2` Tauri command. Phase 2.3 swaps the
//! frontend onto the new IPC.
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
//! - [`bridge`] — Phase 2.3 `FrontendBridgeExecutor` and
//!   `BridgeRouter` plumbing that lets the runtime delegate any
//!   advertised tool back to the Tauri frontend via a one-shot
//!   request/response channel.
//!
//! See `docs/plan/rust-agent-migration.md` for the master plan and
//! the per-phase briefs.

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
pub mod conversation;
pub mod error;
pub mod events;
pub mod hooks;
pub mod ipc;
pub mod recovery;
pub mod session;
pub mod session_store;
pub mod title;
pub mod tool_executor;
pub mod types;

// No top-level `pub use submodule::*;` re-exports. Every internal
// caller in the workspace already imports through the long path
// (`crate::agent_runtime::api_client::ApiError`,
// `crate::agent_runtime::tool_executor::ToolExecutor`, …), and there
// is no external Rust consumer of this crate (the `cdylib` is for
// Tauri's JS bridge, not Rust callers). Adding a re-export layer
// just to silence consumers that don't exist would drag back the
// `unused_imports` warning without any benefit.
