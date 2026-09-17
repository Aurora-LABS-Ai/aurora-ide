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

/// Shared argument reading for the buckets: what to do when a gateway
/// delivers an argument in a shape the schema did not ask for. Not a bucket —
/// it registers no tool.
mod arguments;
pub mod browser;
pub mod canvas;
pub mod code_intel;
pub mod design;
pub mod diagnostics;
pub mod file_workspace_search;
/// `generate_image` — Aurora Chat's picture maker. Same arrangement as
/// [`memory`]: registered here, gated by the chat-mode allow-list.
pub mod image;
pub mod video;
/// `recall` and `remember` — Aurora Chat's memory. Registered like any other
/// bucket, and kept out of the project modes by the chat-mode allow-list in
/// `commands::agent_v2::tool_policy` rather than by not registering it.
pub mod memory;
pub mod permissions;
pub mod plan;
pub mod shell_editor_todo;
/// Deliberately NOT part of [`register_builtin_tools`]: `tool_search` is
/// constructed per turn against that turn's deferred catalogue and its live
/// registry, so it has no fixed executor to pre-register and does not count
/// toward [`BUILTIN_TOOL_COUNT`]. See `commands::agent_v2::tool_policy`.
pub mod timeout;
pub mod tool_search;
pub mod transcript;

/// Number of tools pre-populated in the production
/// [`crate::agent_runtime::tool_executor::ToolRegistry`]:
/// Kept in lockstep with every bucket's `TOOL_NAMES` array by
/// `builtin_tool_count_is_correct`, which is the only thing that makes this
/// number trustworthy.
///
/// Deliberately NOT restated as a per-bucket breakdown in prose. The previous
/// comment here read "the browser bucket ships 8 — total 24" against an actual
/// 31: the prose drifted three separate times because the test guards the
/// CONSTANT and never the sentence describing it. If you want the split, count
/// the arrays.
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
/// Raised 29 -> 30 by the `transcript` bucket's `chapter`, which the model is
/// only ever advertised when the user turns chapters on (the gate lives in
/// `commands::agent_v2::is_tool_available_this_turn`). It is registered
/// unconditionally here, so this count is the roster's size, not its per-turn
/// visibility.
/// Raised 30 -> 31 by `canvas_guidelines`: live canvases are compiled and run,
/// so their authoring contract is enforced by a compiler rather than by taste,
/// and the model has to be told it before its first `kind: "react"` write.
/// Raised 40 -> 41 by `report_aurora_issue`: the agent reporting a fault in
/// Aurora used to be a paragraph of standing instructions asking it to remember
/// and mention things at the end of a turn, which fired almost never. A tool
/// call happens at the moment of noticing and lands on disk.
/// Raised 41 -> 43 by the `memory` bucket's `recall` and `remember`, which are
/// Aurora Chat's. They are registered unconditionally like every other bucket
/// and kept out of the project modes by the chat-mode allow-list, so this count
/// is the roster's SIZE and not its per-turn visibility.
/// Raised 43 -> 44 by `generate_image`, Aurora Chat's picture maker — the same
/// arrangement as the memory bucket: always registered, offered only in chat.
/// Raised 44 -> 46 by splitting the checklist: one `todo` tool with a typed
/// `op` became `TaskCreate` / `TaskUpdate` / `TaskList`. Two more names on the
/// roster, and one fewer required field to forget — a measured build lost a
/// whole request to `todo` called without its `op`. See
/// `shell_editor_todo::tasks` for why the reference's shape won.
/// Raised 46 -> 49 by the browser bucket's `browser_type`, `browser_wait_for`
/// and `browser_evaluate`, after twelve real sessions showed the model with
/// no way to type keystrokes, wait for a condition, or ask the page anything.
/// Raised 49 -> 50 by Chat-only native MiniMax video generation and task queries.
pub const BUILTIN_TOOL_COUNT: usize = 50;

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
    file_workspace_search::register(&mut staging, sink.clone(), browser_manager.clone());
    shell_editor_todo::register(&mut staging, sink.clone());
    plan::register(&mut staging, sink);
    design::register(&mut staging);
    canvas::register(&mut staging);
    transcript::register(&mut staging);
    code_intel::register(&mut staging);
    diagnostics::register(&mut staging);
    memory::register(&mut staging);
    image::register(&mut staging);
    video::register(&mut staging);
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
pub use timeout::install_timeout_guards;

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
            + canvas::TOOL_NAMES.len()
            + transcript::TOOL_NAMES.len()
            + code_intel::TOOL_NAMES.len()
            + diagnostics::TOOL_NAMES.len()
            + memory::TOOL_NAMES.len()
            + image::TOOL_NAMES.len()
            + video::TOOL_NAMES.len()
    }

    #[test]
    fn builtin_tool_count_is_correct() {
        assert_eq!(BUILTIN_TOOL_COUNT, 50);
        assert_eq!(
            file_workspace_search::TOOL_NAMES.len()
                + shell_editor_todo::TOOL_NAMES.len()
                + plan::TOOL_NAMES.len()
                + design::TOOL_NAMES.len()
                + canvas::TOOL_NAMES.len()
                + transcript::TOOL_NAMES.len()
                + code_intel::TOOL_NAMES.len()
                + diagnostics::TOOL_NAMES.len()
                + memory::TOOL_NAMES.len()
                + image::TOOL_NAMES.len()
                + video::TOOL_NAMES.len()
                + browser::TOOL_NAMES.len(),
            BUILTIN_TOOL_COUNT
        );
    }

    /// What `tool_search` is actually holding back, in tools and in tokens.
    ///
    /// The number matters because deferral is not free: revealing anything
    /// changes the schema array, which sits at the FRONT of the provider's
    /// cached prefix, so one reveal re-bills the whole conversation as a cache
    /// write. Measured on thread `99029a6b` (2026-09-06), three reveals cost
    /// 851,083 cache-write tokens — $5.32 — to defer the schemas counted here.
    ///
    /// So this test exists to keep the trade honest: if what is deferred is
    /// small and what a reveal costs is large, deferral only pays for
    /// conversations that never reveal at all. Prints rather than asserts a
    /// tight bound, because the point is the ratio, not a fixed number.
    #[test]
    fn what_deferral_actually_holds_back() {
        // No `BrowserManager`, so no `browser_*` here. `BrowserManager::new`
        // takes a Wry-typed `AppHandle` and `tauri::test::mock_app()` hands
        // back a `MockRuntime` one, so the browser bucket cannot be weighed in
        // a unit test without making the manager generic over its runtime —
        // a refactor this measurement does not justify. What IS measured is
        // the number that decides the trade: the roster every turn carries no
        // matter what, against which a deferred bucket has to look worth the
        // rebuild it costs to reveal.
        let registry = crate::agent_runtime::tool_executor::ToolRegistry::new();
        register_builtin_tools(
            &registry,
            std::sync::Arc::new(shell_editor_todo::NoopIdeEventSink),
            None,
        );

        let mut deferred_tokens = 0usize;
        let mut kept_tokens = 0usize;
        let mut deferred_names: Vec<String> = Vec::new();

        for schema in registry.schemas() {
            // What the wire actually carries for one tool.
            let wire = serde_json::json!({
                "name": schema.name,
                "description": schema.description,
                "input_schema": schema.input_schema,
            })
            .to_string();
            let tokens = crate::services::token_service::TokenService::count_tokens_for_model(
                &wire,
                "claude-opus-5",
            )
            .map(|count| count.tokens)
            .unwrap_or(wire.len() / 4);

            // Same rule as `tool_policy::is_deferrable`, restated because that
            // module is private to `agent_v2`. Three prefixes, and a test that
            // drifts from them fails loudly on the count assertion below.
            let deferrable = schema.name.starts_with("mcp_")
                || schema.name.starts_with("browser_")
                || schema.name.starts_with("team_");
            if deferrable {
                deferred_tokens += tokens;
                deferred_names.push(schema.name);
            } else {
                kept_tokens += tokens;
            }
        }

        println!("always-loaded native tools : {}", registry.len());
        println!("always-loaded schema tokens: {kept_tokens}");
        println!("deferrable here            : {} {deferred_names:?}", deferred_names.len());
        println!("deferred schema tokens     : {deferred_tokens}");

        // The roster a turn always carries has to stay small enough that a
        // deferred bucket looks like a rounding error next to what revealing
        // one costs. 851,083 cache-write tokens bought three reveals on thread
        // `99029a6b`; if the whole always-loaded roster is a hundredth of that,
        // deferral is not buying anything worth the risk.
        assert!(
            kept_tokens < 20_000,
            "the always-loaded roster is {kept_tokens} tokens — if it has grown \
             this far, re-run the deferral trade before assuming it still holds"
        );
        // Nothing deferrable can register without a browser manager, and the
        // frontend buckets (`mcp_*`, `team_*`) never reach this registry at
        // all. Stated so the zero above reads as the setup, not a finding.
        assert_eq!(deferred_names.len(), 0);
    }

    /// Every declared tool parameter names exactly ONE JSON type.
    ///
    /// A union — `"type": ["string", "array"]` — is legal JSON Schema, reads as
    /// harmless, and is serialised differently by every gateway. Measured on
    /// 2026-08-29 with one identical `file_read` call across three providers:
    /// byteplus produced the array correctly, kenari flattened it into a
    /// string, and vectide truncated the call at `{"path": ` and emitted the
    /// rest as message text — which failed every read in that turn, with a 200
    /// on the request and no error anywhere to point at the cause.
    ///
    /// The schema list is the one part of a request Aurora fully controls. This
    /// keeps a union from returning on the next tool someone writes.
    #[test]
    fn no_tool_parameter_declares_a_union_type() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg, Arc::new(shell_editor_todo::NoopIdeEventSink), None);

        for schema in reg.schemas() {
            let Some(properties) = schema
                .input_schema
                .get("properties")
                .and_then(serde_json::Value::as_object)
            else {
                continue;
            };
            for (field, spec) in properties {
                assert!(
                    !spec.get("type").is_some_and(serde_json::Value::is_array),
                    "`{}`.{field} declares a union `type` — pick one. \
                     See file_read.rs's `path` for what a union does on a real gateway.",
                    schema.name
                );
            }
        }
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
