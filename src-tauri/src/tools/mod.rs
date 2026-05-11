//! Aurora native tool buckets — Phase 3 Rust agent migration.
//!
//! Each subagent owns a distinct submodule:
//!
//! - `file_workspace_search` (Sub-C): the 15 read-only and mutating
//!   file/workspace/search tools that wrap existing Rust commands in
//!   `crate::commands::*`.
//! - `shell_editor_todo` (Sub-D): shell + bridge-fired editor + todo
//!   tools (7 tools).
//! - `permissions` (Sub-D): Phase 4 permission prompter scaffolding.
//!
//! Sub-E (this file) composes the first two buckets via
//! [`register_builtin_tools`] so every native executor lands in the
//! production [`crate::agent_runtime::tool_executor::ToolRegistry`]
//! that lives inside [`crate::commands::agent_v2::AgentRegistry`].
//!
//! ## Composer signature
//!
//! The Phase 3 contract template calls for
//! `register_builtin_tools(reg: &mut ToolRegistry)`. Sub-D's bucket
//! also needs an [`crate::tools::shell_editor_todo::IdeEventSink`]
//! (for the four event-firing tools), so the production composer
//! takes both. The destination registry is borrowed through `&` —
//! not `&mut` — because [`ToolRegistry`] is interior-mutable
//! (`Arc<DashMap<String, Arc<dyn ToolExecutor>>>`) and lives inside
//! `AgentRegistry` behind a private `Arc<ToolRegistry>` field that
//! `lib.rs::setup` cannot acquire `&mut` on.
//!
//! Sub-C and Sub-D's bucket-level `register(&mut ToolRegistry, …)`
//! helpers are still invoked verbatim — we satisfy their `&mut`
//! signature against a fresh local staging registry, then transfer
//! the resulting executors into the production registry via the
//! `&self` `ToolRegistry::register` method. This keeps the bucket
//! roster as the single source of truth (one place per bucket
//! lists the executors) and survives the AgentRegistry
//! encapsulation.
//!
//! Sub-E does NOT modify `commands/agent_v2.rs`'s `AgentRegistry`
//! constructor — `lib.rs::setup` simply calls
//! [`register_builtin_tools`] on the registry's `tools()` accessor
//! immediately after construction.
//!
//! ## Roster invariant
//!
//! After a successful [`register_builtin_tools`] call the destination
//! registry contains exactly the union of [`file_workspace_search::TOOL_NAMES`]
//! and [`shell_editor_todo::TOOL_NAMES`] (15 + 7 = 22). The
//! `Sub-E` verify crate (`__verify_phase3_e/`) pins this count.

#![allow(dead_code)]

pub mod browser;
pub mod file_workspace_search;
pub mod permissions;
pub mod shell_editor_todo;

/// Number of tools pre-populated in the production
/// [`crate::agent_runtime::tool_executor::ToolRegistry`]:
/// Sub-C ships 15 (file/workspace/search), Sub-D ships 7
/// (shell/editor/todo), the browser bucket ships 13 — total 35.
pub const BUILTIN_TOOL_COUNT: usize = 35;

/// Compose Sub-C and Sub-D's tool buckets onto `reg`.
///
/// `sink` is shared across Sub-D's four event-firing tools
/// (`shell_spawn`, `editor_open_file`, `read_lints`, `todo_write`)
/// so they can dispatch IDE events without seeing the Tauri
/// `AppHandle` directly. Production builds wire a Tauri-backed
/// sink in `lib.rs::setup`; the verify crate uses a recording
/// mock; tests that don't care about emissions can pass
/// [`shell_editor_todo::NoopIdeEventSink`].
///
/// Idempotent: re-calling the same composer overwrites existing
/// entries (matches the underlying [`ToolRegistry`] semantics —
/// names coalesce on insert).
///
/// # Example
///
/// ```ignore
/// use std::sync::Arc;
/// use crate::agent_runtime::tool_executor::ToolRegistry;
/// use crate::tools::shell_editor_todo::NoopIdeEventSink;
///
/// let registry = Arc::new(ToolRegistry::new());
/// crate::tools::register_builtin_tools(&registry, Arc::new(NoopIdeEventSink));
/// assert_eq!(registry.len(), crate::tools::BUILTIN_TOOL_COUNT);
/// ```
pub fn register_builtin_tools(
    reg: &crate::agent_runtime::tool_executor::ToolRegistry,
    sink: std::sync::Arc<dyn shell_editor_todo::IdeEventSink>,
    browser_manager: Option<std::sync::Arc<crate::services::browser_runtime::BrowserManager>>,
) {
    use crate::agent_runtime::tool_executor::ToolRegistry;

    // Sub-C, Sub-D, and the browser bucket all expose
    // `register(&mut ToolRegistry, …)`. We satisfy their `&mut`
    // signature against a fresh staging registry, then transfer the
    // resulting executors into `reg` (which we only have `&` access
    // to — production AgentRegistry exposes its inner ToolRegistry
    // only through a cloned Arc). `ToolRegistry::register` takes
    // `&self`, so the transfer is a normal interior-mutating insert.
    let mut staging = ToolRegistry::new();
    file_workspace_search::register(&mut staging);
    shell_editor_todo::register(&mut staging, sink);
    if let Some(manager) = browser_manager {
        browser::register(&mut staging, manager);
    }

    for name in staging.names() {
        if let Some(executor) = staging.get(&name) {
            reg.register(executor);
        }
    }
}

/// Wrap every tool with `requires_permission() == true` in a
/// [`permissions::PermissionGuardedExecutor`] backed by `permitter`.
///
/// Decoration happens after [`register_builtin_tools`] so the bucket
/// listings remain the single source of truth — the parent agent
/// flips the gate on by calling this once during `lib.rs::setup` with
/// the production [`permissions::TauriPermitter`].
///
/// The decorator's own `requires_permission()` returns `false`, so a
/// second call to this helper is a no-op rather than triple-wrapping.
pub fn install_permission_gate(
    reg: &crate::agent_runtime::tool_executor::ToolRegistry,
    permitter: std::sync::Arc<dyn crate::agent_runtime::tool_executor::Permitter>,
) {
    let mut wrapped: Vec<String> = Vec::new();
    for name in reg.names() {
        if let Some(executor) = reg.get(&name) {
            if executor.requires_permission() {
                let guarded = permissions::PermissionGuardedExecutor::maybe_wrap(
                    executor,
                    &permitter,
                );
                reg.register(guarded);
                wrapped.push(name);
            }
        }
    }
    eprintln!(
        "[install_permission_gate] wrapped {} tool(s) with permission gate: {:?}",
        wrapped.len(),
        wrapped
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolRegistry;
    use std::collections::HashSet;
    use std::sync::Arc;

    // Tests pass `None` for the browser manager because constructing
    // a real one needs a Tauri AppHandle. The browser bucket has its
    // own unit tests inside `tools::browser::tests`.

    #[test]
    fn builtin_tool_count_is_35() {
        assert_eq!(BUILTIN_TOOL_COUNT, 35);
        assert_eq!(
            file_workspace_search::TOOL_NAMES.len()
                + shell_editor_todo::TOOL_NAMES.len()
                + browser::TOOL_NAMES.len(),
            BUILTIN_TOOL_COUNT
        );
    }

    #[test]
    fn register_builtin_tools_without_browser_mounts_22_tools() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        assert_eq!(reg.len(), 22);
    }

    #[test]
    fn register_builtin_tools_includes_every_sub_c_name() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in file_workspace_search::TOOL_NAMES {
            assert!(
                registered.contains(name),
                "missing Sub-C tool: {name}"
            );
        }
    }

    #[test]
    fn register_builtin_tools_includes_every_sub_d_name() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in shell_editor_todo::TOOL_NAMES {
            assert!(
                registered.contains(name),
                "missing Sub-D tool: {name}"
            );
        }
    }

    #[test]
    fn register_builtin_tools_is_idempotent() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        assert_eq!(reg.len(), 22, "re-register must coalesce");
    }

    #[test]
    fn schemas_match_registered_names() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        for &name in file_workspace_search::TOOL_NAMES
            .iter()
            .chain(shell_editor_todo::TOOL_NAMES.iter())
        {
            let tool = reg.get(name).unwrap_or_else(|| panic!("{name} missing"));
            let schema = tool.schema();
            assert_eq!(schema.name, name);
            assert!(!schema.description.is_empty(), "{name} desc empty");
        }
    }
}
