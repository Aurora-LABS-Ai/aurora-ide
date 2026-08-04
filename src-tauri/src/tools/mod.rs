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
//! After a successful [`register_builtin_tools`] call the destination registry
//! contains exactly the union of every bucket's `TOOL_NAMES`:
//! [`file_workspace_search`], [`shell_editor_todo`], [`plan`], [`design`], and
//! [`browser`] when a `BrowserManager` is supplied — [`BUILTIN_TOOL_COUNT`] in
//! total. The `Sub-E` verify crate (`__verify_phase3_e/`) pins this count.
//!
//! (Do not restate the per-bucket numbers here. This paragraph has been wrong
//! three separate times — "9 + 6 = 15 … total 21" against a real 9/8/23, then
//! "10 + 6 = 16 … total 24" against a real 30 — because
//! `builtin_tool_count_is_correct` guards the constant and never the prose.
//! Naming the buckets instead of counting them cannot drift.)

#![allow(dead_code)]

pub mod browser;
pub mod design;
pub mod file_workspace_search;
pub mod permissions;
pub mod plan;
pub mod shell_editor_todo;

/// Number of tools pre-populated in the production
/// [`crate::agent_runtime::tool_executor::ToolRegistry`]:
/// Sub-C ships 10 (file/workspace/search, including `glob`), Sub-D ships 6
/// (shell/lints/todo — `editor_open_file` was withdrawn once file opens
/// started routing to the Agent Window's right rail), and the browser bucket
/// ships 8 — total 24. Kept in lockstep with the three bucket `TOOL_NAMES`
/// arrays by `builtin_tool_count_is_correct`.
///
/// NB: this constant read 21 against an actual 22 (the browser bucket had
/// already grown to 7). `builtin_tool_count_is_correct` would have caught it,
/// but the lib-test binary cannot launch on Windows here (0xc0000139 — see
/// `.knowledge/lesson.md`), so the drift sat unnoticed. Corrected alongside
/// the `browser_page_outline` addition.
/// Raised again 29 -> 30 by `design_guidelines`, the standing surface doctrine.
/// Raised 24 -> 29 by the Plan Canvas work: the `plan` bucket adds
/// `plan_write` / `plan_read` / `plan_step_update`, and `shell_editor_todo`
/// gained `todo_read` / `todo_update` so the agent can finally read back the
/// task list it wrote instead of re-inventing it after a compaction.
/// Raised 30 -> 31 by `shell_read_output`, which replaces the poll-file_read-and
/// -hope loop for watching a background process.
/// Lowered 31 -> 29 by folding `todo_write` / `todo_update` / `todo_read` into a
/// single `todo` tool with a typed `op`. Three names for one piece of state made
/// the model choose before it could act, and every one of them spoke the same
/// vocabulary of ids, statuses and the cursor.
pub const BUILTIN_TOOL_COUNT: usize = 29;

/// Compose Sub-C and Sub-D's tool buckets onto `reg`.
///
/// `sink` is shared across Sub-D's four event-firing tools
/// (`shell_spawn`, `editor_open_file`, `read_lints`, `todo`)
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
    file_workspace_search::register(&mut staging, sink.clone());
    shell_editor_todo::register(&mut staging, sink.clone());
    plan::register(&mut staging, sink);
    design::register(&mut staging);
    if let Some(manager) = browser_manager {
        browser::register(&mut staging, manager);
    }

    // `staging.names()` is in registration order, so the production
    // registry inherits bucket order (file/workspace/search, then
    // shell/editor/todo, then browser) rather than a per-process shuffle.
    // The schema list is part of every request's cacheable prefix — an
    // unstable order defeats prompt caching and perturbs tool selection.
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
                let guarded =
                    permissions::PermissionGuardedExecutor::maybe_wrap(executor, &permitter);
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

    /// Every bucket except browser, which needs a Tauri `AppHandle` to mount.
    ///
    /// Derived, never a literal: the two registry tests below used to hardcode
    /// this and both had to be hand-edited every time a bucket gained a tool,
    /// which is noise that teaches nothing. The one literal worth keeping is in
    /// `builtin_tool_count_is_correct`, where it exists precisely to fail when
    /// the roster changes so the change has to be deliberate.
    fn count_without_browser() -> usize {
        file_workspace_search::TOOL_NAMES.len()
            + shell_editor_todo::TOOL_NAMES.len()
            + plan::TOOL_NAMES.len()
            + design::TOOL_NAMES.len()
    }

    #[test]
    fn builtin_tool_count_is_correct() {
        assert_eq!(BUILTIN_TOOL_COUNT, 29);
        assert_eq!(
            file_workspace_search::TOOL_NAMES.len()
                + shell_editor_todo::TOOL_NAMES.len()
                + plan::TOOL_NAMES.len()
                + design::TOOL_NAMES.len()
                + browser::TOOL_NAMES.len(),
            BUILTIN_TOOL_COUNT
        );
    }

    #[test]
    fn register_builtin_tools_without_browser_mounts_bucket_tools() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        assert_eq!(reg.len(), count_without_browser());
    }

    #[test]
    fn register_builtin_tools_includes_every_sub_c_name() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in file_workspace_search::TOOL_NAMES {
            assert!(registered.contains(name), "missing Sub-C tool: {name}");
        }
    }

    #[test]
    fn register_builtin_tools_includes_every_sub_d_name() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        let registered: HashSet<String> = reg.names().into_iter().collect();
        for &name in shell_editor_todo::TOOL_NAMES {
            assert!(registered.contains(name), "missing Sub-D tool: {name}");
        }
    }

    #[test]
    fn register_builtin_tools_is_idempotent() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);
        // Re-registering overwrites by name and cannot grow the roster.
        assert_eq!(
            reg.len(),
            count_without_browser(),
            "re-register must coalesce"
        );
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
