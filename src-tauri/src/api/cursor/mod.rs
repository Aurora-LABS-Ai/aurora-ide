//! Cursor (subscription) provider.
//!
//! Lets Aurora drive the models a Cursor subscription can reach — Composer,
//! and the Anthropic / OpenAI / Gemini / Grok tiers Cursor resells — metered
//! against the user's Cursor plan instead of a platform API key.
//!
//! ## How it fits together
//!
//! - [`auth`] — token lifecycle. Cursor's own desktop install is the seed:
//!   `state.vscdb` holds `cursorAuth/accessToken` + `cursorAuth/refreshToken`,
//!   and Aurora reads it **read-only** and never writes back. Refreshed
//!   tokens live in Aurora's own store instead, so a rotation on our side
//!   can never corrupt a database the Cursor editor has open.
//!
//! Unlike [`crate::api::codex`], which shares `~/.codex/auth.json` with the
//! Codex CLI in both directions, this provider is a one-way reader. The
//! difference is not stylistic: `auth.json` is a small file Codex CLI expects
//! third parties to touch, while `state.vscdb` is a live SQLite database
//! backing a running editor.
//!
//! ## Wire shape
//!
//! Cursor's backend is an **agent** protocol, not a model API:
//! `agent.v1.AgentService/Run` over Connect-RPC on HTTP/2, protobuf framed.
//! One turn is a bidirectional exchange — the server pulls conversation
//! history back out of the client mid-stream by content hash, then asks the
//! client to declare its tool set, then streams deltas. That machinery lands
//! alongside this module; `auth` is deliberately standalone so sign-in state
//! is provable before any of it exists.
//!
//! The endpoints here are not a documented public API. They are what Cursor's
//! own CLI speaks, and the wire shape can change without notice.

pub mod adapter;
pub mod auth;
pub mod frame;
pub mod history;
pub mod models;
pub mod session;
pub mod unary;
pub mod usage;

/// Cursor's API root. Both the auth endpoints and `agent.v1.AgentService`
/// live here.
pub const CURSOR_API_BASE: &str = "https://api2.cursor.sh";

/// Refresh endpoint. The **refresh** token goes in as the bearer and a fresh
/// access/refresh pair comes back.
pub const CURSOR_REFRESH_PATH: &str = "/auth/exchange_user_api_key";

/// `x-cursor-client-type`. Cursor gates some behaviour on the client kind;
/// `cli` is the one whose agent protocol this speaks.
pub const CURSOR_CLIENT_TYPE: &str = "cli";

/// `x-cursor-client-version`. Cursor version-gates old clients, so this is
/// the value most likely to need bumping when a turn starts failing with a
/// protocol error rather than an auth error.
pub const CURSOR_CLIENT_VERSION: &str = "cli-2026.08.11-e8db854";
