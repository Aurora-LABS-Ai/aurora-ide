//! Codex (ChatGPT subscription) provider.
//!
//! Lets Aurora drive OpenAI's Codex-tier models (`gpt-5.5`, `gpt-5.4`, …)
//! through the ChatGPT backend — metered against the user's ChatGPT
//! Plus/Pro subscription instead of a platform API key.
//!
//! ## How it fits together
//!
//! - [`auth`] — token lifecycle. `~/.codex/auth.json` (Codex CLI's own
//!   credential file) is the **single source of truth**: an existing CLI
//!   sign-in is picked up automatically, Aurora's own browser PKCE login
//!   writes the same file (signing the CLI in too), and refreshed tokens
//!   are written back so the two never fight over rotation.
//! - [`adapter`] — [`CodexAdapter`], a thin [`StreamingApiClient`] that
//!   resolves a fresh access token per turn, stamps the ChatGPT headers,
//!   and delegates the wire work to the existing Responses-API builders
//!   (`build_responses_body` / `drive_responses_stream`). The Codex
//!   backend speaks the same typed-event `/responses` dialect Aurora
//!   already implements — `store:false`, `instructions`, encrypted
//!   reasoning persistence.
//! - [`usage`] — rate-limit snapshot for the settings card, fetched from
//!   the same endpoint Codex CLI's `/status` uses
//!   (`GET https://chatgpt.com/backend-api/wham/usage`).
//!
//! The chat endpoint (`chatgpt.com/backend-api/codex/responses`) is not a
//! documented public API; OpenAI has publicly endorsed personal
//! subscription use through third-party tools, but the wire shape can
//! change without notice. Everything provider-specific is contained here.
//!
//! [`StreamingApiClient`]: crate::agent_runtime::api_client::StreamingApiClient
//! [`CodexAdapter`]: adapter::CodexAdapter

pub mod adapter;
pub mod auth;
pub mod usage;

/// OAuth client id registered for Codex CLI. Third-party Codex clients
/// (opencode et al.) authenticate with the same id — it is what makes
/// the resulting tokens Codex-entitled.
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// OpenAI's OAuth issuer.
pub const CODEX_ISSUER: &str = "https://auth.openai.com";

/// ChatGPT backend root (usage endpoint lives under `/wham/…`).
pub const CODEX_BACKEND_BASE: &str = "https://chatgpt.com/backend-api";

/// Streaming chat endpoint (Responses-API dialect).
pub const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

/// `originator` header value. Honest self-identification; the backend
/// accepts arbitrary originators (opencode ships its own name).
pub const CODEX_ORIGINATOR: &str = "aurora";

/// User-Agent for Codex backend calls.
pub const CODEX_USER_AGENT: &str = concat!("aurora-ide/", env!("CARGO_PKG_VERSION"));
