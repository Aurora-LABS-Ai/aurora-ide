//! MCP client: Aurora connecting to other people's MCP servers.
//!
//! * `config`     — `~/.aurora/mcp.json` (global) + workspace `.mcp.json`
//!                  (project), `${VAR}` expansion, per-project on/off.
//! * `spawn`      — Windows-correct command lookup + job-object launch.
//! * `client`     — one connection over stdio / Streamable HTTP / legacy SSE,
//!                  protocol handled by rmcp.
//! * `legacy_sse` — the HTTP+SSE transport rmcp no longer ships.
//! * `convert`    — rmcp types → the shapes the frontend reads.
//! * `manager`    — lifecycle owner, events, tool calls.
//!
//! Aurora as an MCP *server* lives in `cli_delegate::mcp`, not here.

pub mod client;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod config;
pub mod convert;
pub mod legacy_sse;
#[cfg(test)]
mod live_tests;
pub mod manager;
pub mod spawn;
pub mod tool;
pub mod types;
