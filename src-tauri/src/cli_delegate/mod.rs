//! `aurora agent` — dispatching work into a running Aurora from a terminal.
//!
//! The GUI CLI in [`crate::cli`] answers "open this folder". This module
//! answers a different question: *"run this task, and let me watch."* You type
//! a prompt in a terminal, it arrives in the Agent Window as a real user
//! message, the agent works on it there, and the transcript streams back to
//! the terminal — or to a file another program is reading.
//!
//! ```text
//! aurora agent "refactor the timeline service" \
//!     --path E:\PayNu-Social\paynu_app \
//!     --provider fireworks --model glm-5.2 --follow
//! ```
//!
//! ## Why a directory and not a socket
//!
//! The hand-off point is [`crate::paths::cli_tasks_dir`]: the CLI writes a
//! `<id>.task.json`, the running app claims it and appends events to a
//! `<id>.jsonl` beside it.
//!
//! That shape is forced by three requirements, and no socket satisfies all
//! three:
//!
//! - **The command must work when Aurora is not running yet.** A file waits on
//!   disk until the app starts and sweeps the folder. A socket has nobody
//!   listening, so the dispatch would have to fail or block.
//! - **The transcript must be readable by a third party, live.** Another
//!   agent, a CI step, a `tail -f` in the next pane. If the stream is already
//!   a file, that is free; with a socket it needs a second artifact that
//!   duplicates the first.
//! - **A dispatch must survive the terminal that made it.** You fire a long
//!   task and close the window. The record is on disk, not in a dead process's
//!   buffer.
//!
//! It also costs no new dependency: `notify` (already in the build, driving
//! the file explorer and the workspace watcher) is what the running app uses
//! to notice a new task file.
//!
//! ## Two front doors, one hand-off
//!
//! A terminal is not the only thing that wants to send Aurora work. Another
//! agent does too, and it speaks MCP rather than argv. So [`mcp`] is a second
//! entrance onto the same machinery: `aurora mcp` is a Model Context Protocol
//! server that turns a tool call into exactly the task file `aurora agent`
//! writes, and reads back exactly the transcript `--follow` tails.
//!
//! The two differ in one way that matters, and it is a deliberate asymmetry.
//! `aurora agent` works when Aurora is closed, because a request waits on disk.
//! MCP does not: a tool call is answered now or not at all, so it is gated on
//! the Agent Window actually being open — and on the user having switched the
//! whole thing on, which is off by default. [`bridge`] is how a separate
//! process learns both.
//!
//! ## Layout
//!
//! - [`task`] — the wire contract: what a request is, what a transcript line
//!   is. Stable on purpose; other programs read it.
//! - [`inbox`] — the task directory, and the atomicity rules that let two
//!   processes share it without a lock.
//! - [`cancel`] — stopping a task, whichever of its three lives it is in.
//! - [`bridge`] — what the running app publishes about itself, for a process
//!   that is not it.
//! - [`mcp`] — the MCP server: the same work, asked for by an agent.
//! - [`term`] — the presentation layer: palette, glyphs, and whether styling
//!   is allowed at all.

pub mod bridge;
pub mod cancel;
pub mod catalog;
pub mod command;
pub mod commands;
pub mod follow;
pub mod inbox;
pub mod list;
pub mod mcp;
pub mod mirror;
pub mod presence;
pub mod render;
pub mod run;
pub mod task;
pub mod term;
pub mod threads;
pub mod tui;
pub mod watcher;
