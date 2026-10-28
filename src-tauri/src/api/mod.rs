//! HTTP / SSE provider adapters for the Rust agent runtime.
//!
//! Phase 2.2 lands a thin wrapper around Aurora's existing
//! [`provider_kernel`] machinery so that
//! [`crate::agent_runtime::api_client::StreamingApiClient`] can drive
//! real Anthropic and OpenAI-compatible streaming calls. The adapters
//! here intentionally **do not** modify provider_kernel — they rebuild
//! the minimum HTTP+SSE plumbing needed by the trait surface, riding on
//! the Phase-5 SSE bug fixes (byte-level frame splitter, CancellationToken,
//! `signature_delta` accumulator).
//!
//! ## Layout
//!
//! - [`client`] — [`ProviderConfigSnapshot`], [`ProviderKind`], and the
//!   [`build_api_client`] factory. The factory dispatches on
//!   `provider_id` (no `base_url` introspection).
//! - [`anthropic`] — [`AnthropicAdapter`] for `provider_id` ∈
//!   `{"anthropic", "minimax"}`.
//! - [`anthropic_api`] — the built-in Anthropic row (`"anthropic-api"`):
//!   the same Messages wire plus what only Anthropic itself accepts.
//! - [`responses`] — [`OpenAIResponsesAdapter`] for `provider_id`
//!   `"openai-responses"` (OpenAI's typed-event `/responses` wire
//!   shape — an additional provider type, not a replacement for
//!   Chat Completions).
//! - [`openai_compat`] — [`OpenAICompatAdapter`] for everything else
//!   (`deepseek`, `glm`, `fireworks`, `openai`, `lmstudio`, `ollama`,
//!   `custom`, …).
//! - [`provider_kernel_adapter`] — wire-shape JSON types, body builders,
//!   header builders, error mapping. Re-exports the SSE frame buffer
//!   from [`sse_shared`] for backwards compatibility.
//! - [`aurora_image`] — validated `<aurora_image …>` marker parsing, shared
//!   with the agent runtime. The single detector for "embedded image" vs
//!   "text that merely mentions the marker syntax".
//! - [`sse_shared`] — Phase 5 (Sub-E) consolidation point for the
//!   byte-level [`sse_shared::SseFrameBuffer`] and
//!   [`sse_shared::frame_payloads`] helpers shared by every adapter.
//! - [`sse`] — doc-only stub (see file note).
//!
//! ## Why we wrap, not call into, provider_kernel
//!
//! [`provider_kernel`] (the IDE chat's plain stream, `commands::provider_kernel`
//! until 2026-10-28) emits each chunk as a named event through the host's
//! event sink rather than returning them. There is no clean way to consume
//! those events back into our `mpsc::Sender<AssistantEvent>`, and the
//! modules that hold the parsed JSON types (`provider_kernel::types`) are
//! `mod types;` (private to provider_kernel). Phase 2.2 therefore
//! re-implements the minimum SSE plumbing in
//! [`provider_kernel_adapter`] using exactly the same patterns the
//! kernel uses (`SseFrameBuffer`, `frame_payloads`, byte-level
//! buffering, `CancellationToken` via `tokio::select!`). Phase 5 will
//! retire `provider_kernel` and merge these modules.

pub mod anthropic;
pub mod anthropic_api;
pub mod antigravity;
pub mod aurora_image;
pub mod claude_code;
pub mod client;
pub mod codex;
pub mod commandcode;
pub mod cursor;
pub mod deepseek;
pub mod deepseek_balance;
pub mod kenari;
pub mod local_providers;
pub mod meta;
pub mod minimax;
pub(crate) mod model_config;
pub mod modal;
pub mod openai_compat;
pub mod opencode;
pub mod pool;
pub mod provider_catalog;
pub mod provider_kernel;
pub mod provider_models;
pub mod provider_kernel_adapter;
pub mod provider_test;
pub mod responses;
pub mod sse;
pub mod sse_shared;

#[cfg(test)]
mod stream_recovery_tests;

// Only `client::*` is re-exported at the short path because
// `crate::agent_runtime::ipc::tests` and `crate::lib` reference
// `crate::api::ProviderConfigSnapshot` / `crate::api::build_api_client`
// directly. `AnthropicAdapter` and `OpenAICompatAdapter` are only
// instantiated by the factory inside `client.rs`, so re-exporting them
// here just produces `unused_imports` noise.
pub use client::*;
