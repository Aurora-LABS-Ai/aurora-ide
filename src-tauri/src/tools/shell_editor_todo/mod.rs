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
//! 2. **Editor** (`editor_open_file`) — opens files through Tauri events.
//!    There is no diagnostics tool: `read_lints` wrapped the project's own
//!    checkers and twice summarised a checker that never ran as a clean
//!    result (harness runs 2026-08-21 and 2026-09-28). The model now runs
//!    the project's check command itself with `shell_execute` and reads
//!    the raw output; the rule lives in the system prompt.
//! 3. **Todo** (`todo`) — ONE tool with a typed `op` (set / update /
//!    read) over the durable per-thread checklist in
//!    [`todo_store`]. It was three tools (`todo_write`, `todo_update`,
//!    `todo_read`); they shared all their vocabulary and differed only
//!    in which fields were required, so the split cost the roster three
//!    slots and cost the model a choice on every call.
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
//! - `shell_kill`, `shell_list_processes`, `editor_open_file`, `todo` →
//!   default `false` (read/UI/own-process ops are safe).

#![allow(dead_code)]

use std::sync::Arc;

use crate::agent_runtime::tool_executor::ToolRegistry;

pub mod editor_open_file;
pub mod ide_event_sink;
pub mod shell_execute;
pub mod shell_kill;
pub mod shell_list_processes;
pub mod shell_read_output;
pub mod shell_spawn;
pub mod tasks;
pub mod todo_store;

pub use ide_event_sink::{
    FileChangeKind, FileChangedPayload, IdeEventSink, NoopIdeEventSink, PlanChangeReason,
    PlanChangedPayload, RecordedEvent, RecordingIdeEventSink, FILE_CHANGED_EVENT,
    PLAN_CHANGED_EVENT,
};

/// Names of every tool this bucket registers, in roster order.
///
/// Used by the bucket-level smoke test, the verify crate's
/// `register_mounts_all_7_tools` assertion, and Sub-E's composer
/// test.
/// `editor_open_file` is deliberately absent. Opening a file is a *viewing*
/// action, and the Agent Window shows files in its own right rail — asking the
/// model to drive the IDE's Monaco editor sent the user's attention to another
/// window mid-turn. The frontend now routes every open into the rail, so the
/// model does not need (or get) a tool for it.
pub const TOOL_NAMES: &[&str] = &[
    "shell_execute",
    "shell_spawn",
    "shell_kill",
    "shell_list_processes",
    "shell_read_output",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
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
    reg.register(Arc::new(shell_read_output::ShellReadOutputTool::new(
        sink.clone(),
    )));
    // `editor_open_file` is intentionally NOT registered — see TOOL_NAMES.
    // The executor and its `agent_editor_open` event remain compiled because
    // the Agent Window still listens on that channel to open files in its
    // right rail.
    // The checklist, in Claude Code's shape: one task per create, one task per
    // update, and a read. Several calls ride in one message — see `tasks`.
    reg.register(Arc::new(tasks::TaskCreateTool::new(sink.clone())));
    reg.register(Arc::new(tasks::TaskUpdateTool::new(sink)));
    reg.register(Arc::new(tasks::TaskListTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn register_mounts_every_bucket_tool() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        assert_eq!(reg.len(), TOOL_NAMES.len(), "every bucket tool must mount");
        assert!(
            !reg.names().contains(&"editor_open_file".to_string()),
            "editor_open_file must not be offered to the model — opens route to the right rail"
        );

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
            .filter(|n| reg.get(n).map(|t| t.requires_permission()).unwrap_or(false))
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
