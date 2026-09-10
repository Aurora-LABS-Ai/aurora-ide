//! Aurora as an MCP server: other agents sending it work.
//!
//! Aurora has been an MCP *client* since the beginning — it connects to servers
//! and uses their tools ([`crate::mcp`]). This is the other direction. `aurora
//! mcp` is a Model Context Protocol server that another agent connects to, and
//! through it that agent can send Aurora a task, watch it run, stop it, and
//! read back what happened.
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "aurora": { "command": "C:\\...\\aurora.exe", "args": ["mcp"] }
//!   }
//! }
//! ```
//!
//! ## It reuses the terminal's path, deliberately
//!
//! A tool call here writes exactly the task file `aurora agent` writes, into
//! exactly the same directory, and reads back exactly the transcript `--follow`
//! tails. Nothing about the runtime, the window, or the wire format knows which
//! of the two asked.
//!
//! That is worth stating because the alternative is tempting and wrong. A
//! second, MCP-shaped path into the runtime would be a second set of bugs, a
//! second thing to keep working when the turn loop changes, and — worst — a
//! second answer to "what happened", when the transcript already exists and is
//! already something a third party can read while it runs. The feature the CLI
//! was built around is the feature an agent needs.
//!
//! ## Three conditions, and none of them are assumed
//!
//! Unlike `aurora agent`, an MCP call cannot wait on disk for an Aurora that
//! does not exist yet: the caller wants an answer now. So every tool but
//! `aurora_agent_status` requires all three of
//!
//! 1. an Aurora process running,
//! 2. the **Agent Window** open — not the IDE window, which cannot run a task,
//! 3. the user's switch turned on, which is off until they turn it on.
//!
//! [`super::bridge`] is how a separate process learns 2 and 3, and
//! [`super::presence`] is 1.
//!
//! `aurora_agent_status` is exempt because it is the tool that *reports* those
//! conditions, and a status check that needed the thing it was checking would
//! leave a caller with no way to find out what was wrong.
//!
//! The roster is never gated. Every tool is listed whether or not Aurora is
//! running, so an agent that connects to a closed Aurora can read what it would
//! be able to do and tell the user to open it — instead of seeing an empty
//! server and concluding there is nothing here.
//!
//! ## Layout
//!
//! - [`protocol`] — JSON-RPC 2.0 and the MCP methods, hand-written; the module
//!   docs say why rather than using `rmcp`'s server half.
//! - [`tools`] — the roster, the descriptions another model reads, and what
//!   each call does.
//! - [`serve`] — the stdio loop.

pub mod clients;
pub mod protocol;
pub mod serve;
pub mod tools;
