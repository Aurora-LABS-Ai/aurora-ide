# Phase 3 + 4 + 5 Locked Contract

**Status:** locked. Three subagents (Sub-C, Sub-D, Sub-E) work in parallel against this contract. After they finish the parent agent integrates and the migration sits at ~90% done, ready for user testing.

## 0. The big picture

Most "tool ports" are not ports — they are `ToolExecutor` wrappers around already-shipped Rust Tauri commands (`crate::commands::read_file_content`, `execute_command`, `aurora_websearch`, etc.). When a Rust command exists, the executor calls the inner function directly (NOT via Tauri invoke). When it doesn't, the subagent ports the TS executor logic into a fresh Rust function under the new `crate::tools::` module.

A new top-level Rust module `src-tauri/src/tools/` is created and owned jointly: each subagent puts its bucket in a separate submodule, and Sub-E composes them via a single `register_builtin_tools(reg: &mut ToolRegistry)`.

## 1. New module layout

```
src-tauri/src/tools/
├── mod.rs                  // re-exports + `register_builtin_tools`
├── file_workspace_search/  // Sub-C
│   ├── mod.rs              // pub fn register(reg: &mut ToolRegistry)
│   ├── file_read.rs
│   ├── file_write.rs
│   ├── file_patch.rs       // ported from src/tools/executors/file-executors-enhanced.ts (apply_patch logic)
│   ├── file_create.rs
│   ├── file_delete.rs
│   ├── file_exists.rs
│   ├── grep.rs             // calls crate::commands::ripgrep_search
│   ├── multi_file_read.rs  // calls crate::commands::read_files_batch
│   ├── search_replace.rs   // ported from src/tools/executors/search-replace-utils.ts
│   ├── multi_search_replace.rs
│   ├── workspace_tree.rs   // calls crate::commands::read_directory
│   ├── folder_create.rs    // calls crate::commands::create_folder
│   ├── folder_delete.rs    // calls crate::commands::delete_path (with safety checks)
│   ├── aurora_search.rs    // calls semantic search Tauri command path
│   └── auroro_websearch.rs // calls crate::commands::aurora_websearch
├── shell_editor_todo/      // Sub-D
│   ├── mod.rs              // pub fn register(reg: &mut ToolRegistry)
│   ├── shell_execute.rs    // calls crate::commands::execute_command + bash_validation
│   ├── shell_spawn.rs      // calls crate::commands::execute_command_stream + bash_validation
│   ├── shell_kill.rs       // calls crate::commands::cancel_command_stream
│   ├── shell_list_processes.rs
│   ├── editor_open_file.rs // emits a Tauri event "agent_editor_open" with payload {path}
│   ├── read_lints.rs       // emits a Tauri event "agent_read_lints" + awaits frontend reply via a new `agent_lints_response` command (mirror the bridge pattern, but Phase 4 shouldn't bloat — keep it minimal: fire-and-forget, return placeholder text)
│   └── todo_write.rs       // emits a Tauri event "agent_todo_write" with payload {tasks}
└── permissions/             // Sub-D (Phase 4 permission scaffolding)
    ├── mod.rs
    └── prompter.rs
```

The `read_lints` and `editor_open_file` and `todo_write` tools emit events because their effect is on the frontend (Monaco editor, Zustand stores). Their `ToolExecutor::execute` returns a synchronous "ok, fired" string — the frontend's audit panel updates from the event, not from the tool result. Match the existing TS executor semantics (which also fire-and-forget for these).

## 2. ToolExecutor pattern

Every executor follows this template:

```rust
use async_trait::async_trait;
use crate::agent_runtime::tool_executor::{ToolExecutor, ToolContext, ToolError, ToolResult};

pub struct FileReadTool;

#[async_trait]
impl ToolExecutor for FileReadTool {
    fn name(&self) -> &str { "file_read" }
    fn description(&self) -> &str { "Read a file from the workspace." }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative or absolute path." }
            },
            "required": ["path"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let path: String = serde_json::from_value(
            input.get("path").cloned().ok_or_else(|| ToolError::InvalidInput("missing path".into()))?
        ).map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        // Path safety FIRST when ctx.workspace_root is set.
        let resolved = match &ctx.workspace_root {
            Some(root) => crate::agent_safety::resolve_within_workspace(root, &path)
                .map_err(|e| ToolError::PolicyViolation(e.to_string()))?,
            None => std::path::PathBuf::from(&path),
        };

        let content = crate::commands::read_file_content(resolved.to_string_lossy().to_string())
            .await
            .map_err(|e| ToolError::Execution(e))?;

        Ok(ToolResult { content, is_error: false })
    }
}
```

If `ToolError` doesn't already have `PolicyViolation` and `InvalidInput` variants, Sub-C/Sub-D may add them (touch `agent_runtime/tool_executor.rs` minimally — additive only).

## 3. Sub-bucket registration helpers

Each bucket exposes a single public entry-point:

```rust
// src-tauri/src/tools/file_workspace_search/mod.rs
pub fn register(reg: &mut crate::agent_runtime::tool_executor::ToolRegistry) {
    reg.register(std::sync::Arc::new(file_read::FileReadTool));
    reg.register(std::sync::Arc::new(file_write::FileWriteTool));
    // ...
}
```

Sub-E composes via:

```rust
// src-tauri/src/tools/mod.rs
pub mod file_workspace_search;
pub mod shell_editor_todo;
pub mod permissions;

pub fn register_builtin_tools(reg: &mut crate::agent_runtime::tool_executor::ToolRegistry) {
    file_workspace_search::register(reg);
    shell_editor_todo::register(reg);
}
```

Sub-E updates `lib.rs::setup` to populate the `AgentRegistry`'s tool registry once at startup so every turn re-uses the same `Arc<ToolRegistry>` (the existing `AgentRegistry::tools()` accessor already supports this).

## 4. Phase 4 permission prompter (Sub-D)

Sub-D adds an optional permission-gate path that the runtime consults BEFORE dispatching a tool:

- New trait `Permitter` in `agent_runtime/tool_executor.rs` (or new `permissions.rs` submodule):
  ```rust
  #[async_trait]
  pub trait Permitter: Send + Sync + 'static {
      async fn request(
          &self,
          turn_id: &str,
          tool_name: &str,
          input: &serde_json::Value,
          cancel: tokio_util::sync::CancellationToken,
      ) -> Result<bool, ToolError>;
  }
  ```
- `ToolRegistry` gets an optional `Arc<dyn Permitter>`. When set, `ToolRegistry::execute(name, input, ctx)` (a new method, additive) consults the permitter before invoking the executor. When unset (default), execution flows through unchanged so existing tests pass.
- Production `Permitter` impl (`TauriPermitter`) emits a new event channel `"agent_permission_request"` with `{turnId, toolName, input}` and awaits a oneshot. Frontend posts the verdict via a new command `agent_grant_permission(turn_id, tool_name, granted: bool)`.
- The frontend can decide on the permitter level "auto/always_ask/deny" using the existing `tool_settings` table — but Sub-D's job is just to ship the prompter; the frontend wiring of "always_ask UI" is left for the parent's final 10% (or stays as the existing TS approval modal — bridge tools already use it, so non-bridge Rust tools just default to "auto" until the parent wires the modal in).
- For Phase 3 tools that should ALWAYS prompt (shell_*, file_delete, folder_delete), the ToolExecutor impl can set a `requires_permission()` method returning `bool` so the permitter only fires for high-risk tools. Default `false` everywhere; Sub-D overrides to `true` for shell_* and the destructive file/folder ops.

## 5. Phase 4 hooks (Sub-E)

Sub-E adds a small hook system in `agent_runtime/hooks.rs`:

```rust
#[async_trait]
pub trait Hook: Send + Sync + 'static {
    async fn pre_tool_use(&self, _name: &str, _input: &serde_json::Value) {}
    async fn post_tool_use(&self, _name: &str, _result: &ToolResult) {}
}
```

`ConversationRuntime` accepts `Arc<dyn Hook>` (default: a no-op). Hooks fire around every `ToolRegistry::execute` call. Tests cover: pre-fires-before, post-fires-after-with-result, post-fires-on-error too.

## 6. Phase 4 recovery recipes (Sub-E)

`agent_runtime/recovery.rs` ships a small library:

```rust
pub fn classify_error(err: &str) -> Option<RecoveryHint>;

pub enum RecoveryHint {
    AuthExpired,
    RateLimited,
    NetworkRetryable,
    InvalidPath,
    PermissionDenied,
    Unknown,
}
```

Used by `TurnDriver::run_turn` to enrich the `agent_turn_error` payload with a recoverable-hint field when applicable. Frontend ignores it for Phase 3 (parent wires UI later); the Rust side just lands the classifier with tests.

## 7. Phase 5 finalize — provider_kernel fold (Sub-E)

Sub-E does NOT relocate `provider_kernel`'s files. Instead, Sub-E thins out the existing `api/anthropic.rs` and `api/openai_compat.rs` to confirm they already use `provider_kernel`'s SSE byte-buffer / cancellation primitives where useful — and adds inline doc-comments documenting which `provider_kernel::*` symbols they reuse. If the adapters duplicate logic from `provider_kernel::parsers`, factor the shared chunk out into `api::sse_shared`. No file moves, no breaking changes — the rename/relocation is for a future phase if needed at all.

This is enough Phase 5 for the migration to be "functionally complete" — the IDE will run on the Rust agent loop, every provider works, and the only remaining `provider_kernel` consumer is the legacy `aurora_provider_chat` Tauri command path (kept until the legacy TS code that calls it is deleted in cleanup).

## 8. Frontend slimming (Sub-E)

After Sub-C and Sub-D's tools land, the bridge will rarely fire (only for tools the Rust registry doesn't know — i.e. MCP tools). Sub-E:

1. Updates `src/services/agent-runtime-client.ts::dispatchToolPending` to log a console.warn when a non-MCP tool comes through the bridge (it shouldn't after Phase 3) and dispatch via the runner anyway as a fallback.
2. Trims unused imports / executors in `src/tools/index.ts` — keeps the registry intact for the bridge fallback path but marks the Rust-ported tool definitions as `nativeRustOwned: true` (a new field on `ToolDefinition`). Sub-E does NOT delete TS executor files in this batch; the parent does that in the final 10% after manual smoke tests confirm Rust paths work.
3. `pnpm tsc --noEmit` clean.

## 9. Verification (per subagent)

Each subagent ships a standalone `__verify_phase3_<bucket>/` crate following the `__verify_phase2_3a/` template. Mock the underlying file system / shell where the test is asserting executor logic; integration with real `crate::commands::*` is exercised by the main `cargo check`.

Sub-C target: ≥ 30 tests covering all 15 tools + path safety.
Sub-D target: ≥ 25 tests covering all 7 tools + permission prompter + bash_validation integration.
Sub-E target: ≥ 20 tests covering registry composition + hooks + recovery classifier + thin-API doc audit.

Main `cargo check --lib --no-default-features --features cpu-only` MUST stay clean after each merge.

## 10. Hand-off to parent (final 10%)

Parent agent picks up:
1. Wiring `TauriPermitter` into the production `AgentRegistry` setup (Sub-D ships the trait; parent flips the switch).
2. Wiring the frontend's permission modal for Rust-ported tools (currently only bridge tools see it).
3. Manual smoke pass through the 5-step checklist Sub-B already drafted, plus tool-by-tool spot checks.
4. Deleting `src/tools/executors/*.ts` (15 files) once smoke passes — single big PR.
5. Running `cargo test` and `pnpm test` end-to-end.
6. Final cargo + pnpm dependency audits.
7. Optional: Phase 5 deeper consolidation if desired (delete `provider_kernel/` once nothing else references it).

That's the 10% the user wraps via the parent. Subagents do NOT touch this surface.

## 11. Hard cross-cutting rules (apply to all 3 subagents)

1. **PowerShell-only on Windows.** No POSIX `find`/`grep`/`sed`. Use `Get-ChildItem`, `Select-String`, etc.
2. **Verify standalone, not via main `cargo test`.** The main test binary fails at launch (ONNX DLL). Use `__verify_phase3_<bucket>/` crates exclusively.
3. **Do NOT modify Phase 2.3 contract files** (`docs/plan/phase-2-3-contract.md`).
4. **Do NOT spawn sub-subagents.** This is the LAST batch.
5. **Match existing code style.** Read the neighbouring file before writing.
6. **Additive changes only.** No removals, no renames, no signature changes to anything outside your bucket. The parent's final 10% deletes TS files and possibly does Phase 5 deeper consolidation.
7. **No new frontend dependencies.** Use what `package.json` already has.
8. **Cargo workspace** lives at `E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri`. Frontend root is `E:\VOID-EDITOR\Aurora-Agent-IDE`.

## 12. Each subagent reports

1. Diff summary with file paths.
2. Standalone verify crate test count and pass count.
3. `cargo check --lib --no-default-features --features cpu-only` output line.
4. (Sub-E only) `pnpm tsc --noEmit` clean.
5. Any deviation from this contract with explicit justification (or "none").
6. (Sub-D only) The exact event-channel + command names for the new permission prompter, so the parent can wire the frontend modal in the final 10%.
7. (Sub-E only) The exact behaviour the frontend bridge falls back to when a non-MCP tool arrives — so the parent knows what regression risks remain before deleting TS executors.
