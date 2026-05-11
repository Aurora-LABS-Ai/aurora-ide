//! Shell / editor / todo tool bucket — Phase 3 Sub-D.
//!
//! Wraps three families of behaviour as [`ToolExecutor`] trait impls
//! and exposes [`register`] so Sub-E's composer can mount the whole
//! bucket onto a [`ToolRegistry`]:
//!
//! 1. **Shell** (`shell_execute`, `shell_spawn`, `shell_kill`,
//!    `shell_list_processes`) — wraps the Rust commands in
//!    `crate::commands::*` and gates `shell_execute` /
//!    `shell_spawn` through
//!    [`crate::agent_safety::bash_validation::validate_command`].
//! 2. **Editor** (`editor_open_file`, `read_lints`) — fire-and-forget
//!    Tauri events. The frontend updates Monaco / lint state from the
//!    event; the tool result is just an acknowledgement string.
//! 3. **Todo** (`todo_write`) — fire-and-forget Tauri event for the
//!    task panel.
//!
//! ## `IdeEventSink`
//!
//! Tools 5–7 (and the `shell_spawn` background-process launcher) need
//! to talk to the Tauri layer (emit events, spawn streamed commands).
//! [`ToolContext`] cannot carry an `AppHandle` directly without
//! breaking every existing construction site, so we abstract the
//! dependency behind an [`IdeEventSink`] trait that's injected into
//! each tool at construction time. Production wiring builds a
//! Tauri-backed sink in `lib.rs::setup`; the verify crate uses a
//! recording mock.
//!
//! Sub-E's composer calls [`register`] with a sink — the parent agent
//! wires the production sink in the final 10%.
//!
//! ## Bash validation
//!
//! [`shell_execute`](shell_execute::ShellExecuteTool) and
//! [`shell_spawn`](shell_spawn::ShellSpawnTool) both run their input
//! command through
//! [`crate::agent_safety::bash_validation::validate_command`] in
//! [`ExecutionMode::WorkspaceWrite`] BEFORE invoking the underlying
//! Rust command. Hard blocks become [`ToolError::PolicyViolation`].
//! Warning-level results (destructive patterns) also become
//! `PolicyViolation` — the agent should ask the user via the
//! permission prompter, which fires before the tool ever reaches its
//! body.
//!
//! ## Permission gating
//!
//! Per contract §4 / Sub-D's hard rules:
//!
//! - `shell_execute`, `shell_spawn` → `requires_permission() == true`
//! - `shell_kill`, `shell_list_processes`, `editor_open_file`,
//!   `read_lints`, `todo_write` → default `false` (read/UI/own-process
//!   ops are safe).

#![allow(dead_code)]

use std::sync::Arc;

use crate::agent_runtime::tool_executor::ToolRegistry;

pub mod editor_open_file;
pub mod ide_event_sink;
pub mod read_lints;
pub mod shell_execute;
pub mod shell_kill;
pub mod shell_list_processes;
pub mod shell_spawn;
pub mod todo_write;

pub use ide_event_sink::{IdeEventSink, NoopIdeEventSink, RecordingIdeEventSink};

/// Names of every tool this bucket registers, in roster order.
///
/// Used by the bucket-level smoke test, the verify crate's
/// `register_mounts_all_7_tools` assertion, and Sub-E's composer
/// test.
pub const TOOL_NAMES: &[&str] = &[
    "shell_execute",
    "shell_spawn",
    "shell_kill",
    "shell_list_processes",
    "editor_open_file",
    "read_lints",
    "todo_write",
];

/// Tools that opt into the Phase 4 permission gate
/// (`requires_permission() == true`). Used by the verify crate to
/// pin the contract.
pub const TOOLS_REQUIRING_PERMISSION: &[&str] = &["shell_execute", "shell_spawn"];

/// Register every tool in this bucket against `reg`. Idempotent: a
/// re-registration overwrites the existing entry (same DashMap
/// behaviour as Sub-C's bucket).
///
/// `sink` is shared across editor / todo / shell-spawn tools so they
/// can fire events without seeing the Tauri `AppHandle` directly.
pub fn register(reg: &mut ToolRegistry, sink: Arc<dyn IdeEventSink>) {
    reg.register(Arc::new(shell_execute::ShellExecuteTool::new(sink.clone())));
    reg.register(Arc::new(shell_spawn::ShellSpawnTool::new(sink.clone())));
    reg.register(Arc::new(shell_kill::ShellKillTool));
    reg.register(Arc::new(shell_list_processes::ShellListProcessesTool));
    reg.register(Arc::new(editor_open_file::EditorOpenFileTool::new(
        sink.clone(),
    )));
    reg.register(Arc::new(read_lints::ReadLintsTool::new(sink.clone())));
    reg.register(Arc::new(todo_write::TodoWriteTool::new(sink)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolExecutor;
    use std::collections::HashSet;

    #[test]
    fn register_mounts_all_7_tools() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        assert_eq!(reg.len(), TOOL_NAMES.len(), "expected 7 tools in bucket");

        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in TOOL_NAMES {
            assert!(
                registered.contains(name),
                "expected '{name}' in registered tools"
            );
        }
    }

    #[test]
    fn schemas_match_tool_names() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        for &name in TOOL_NAMES {
            let tool = reg.get(name).unwrap_or_else(|| panic!("{name} missing"));
            let schema = tool.schema();
            assert_eq!(
                schema.name, name,
                "schema name must match registry name for {name}"
            );
            assert!(
                !schema.description.is_empty(),
                "schema description must not be empty for {name}"
            );
        }
    }

    #[test]
    fn permission_required_set_matches_contract() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        let mut required: Vec<String> = reg
            .names()
            .into_iter()
            .filter(|n| {
                reg.get(n)
                    .map(|t| t.requires_permission())
                    .unwrap_or(false)
            })
            .collect();
        required.sort();
        let mut expected: Vec<&str> = TOOLS_REQUIRING_PERMISSION.to_vec();
        expected.sort();
        let expected_owned: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(required, expected_owned);
    }

    #[test]
    fn re_register_overwrites() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        register(&mut reg, Arc::new(NoopIdeEventSink));
        assert_eq!(reg.len(), TOOL_NAMES.len(), "duplicate names must coalesce");
    }
}
