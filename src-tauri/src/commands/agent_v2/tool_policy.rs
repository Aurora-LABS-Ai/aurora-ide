//! Agent runtime IPC — What the model is allowed to call this turn: the per-turn registry, the
//! withdrawn roster, plan-mode gating, and the plan-mode shell allow-list.
//!
//! Split out of `agent_v2.rs` verbatim; see `mod.rs` for the map.

use super::*;

use crate::tools::tool_search::ToolSearchExecutor;

/// Tools that may be held back from the roster and loaded on demand.
///
/// The rule is "would a turn stall without it?". Reading, editing, searching
/// and running things are how a turn starts, so they are always advertised —
/// deferring them would buy a few hundred tokens and pay a round trip for it on
/// every single turn.
///
/// What IS deferrable is everything whose cost is unbounded or conditional:
/// - `mcp_*` — unbounded by definition. Several connected servers can push the
///   roster past a hundred tools, and their schemas are the largest single
///   block Aurora sends on behalf of tools most conversations never touch.
/// - `browser_*` — 16 schemas, ~2,800 tokens, on turns that mostly never open a
///   page. This is strictly better than the existing on/off switch: the tokens
///   are not spent, and the capability is still reachable.
/// - `team_*` — a whole coordination vocabulary that only matters once the user
///   is actually running a team.
pub(super) fn is_deferrable(name: &str) -> bool {
    name.starts_with("mcp_") || name.starts_with("browser_") || name.starts_with("team_")
}

/// Add `executor` to the deferred catalogue, mirroring
/// [`ToolRegistry::register`]'s overwrite-in-place rule.
///
/// The native pass runs after the bridge pass and must shadow it by name — the
/// same precedence the registry itself applies — while keeping the entry's
/// original position, because that position is part of the description the
/// model reads and therefore part of the cacheable prefix.
fn defer(catalog: &mut Vec<Arc<dyn ToolExecutor>>, executor: Arc<dyn ToolExecutor>) {
    if let Some(slot) = catalog
        .iter_mut()
        .find(|existing| existing.name() == executor.name())
    {
        *slot = executor;
    } else {
        catalog.push(executor);
    }
}

/// Build a per-turn [`ToolRegistry`] starting with [`FrontendBridgeExecutor`]
/// entries for every [`AllowedTool`] the model is allowed to call,
/// then overlaying the registry-level catalogue (Phase 3 native Rust
/// executors) so they shadow any bridge entry with the same name.
///
/// Phase 3 makes Rust the source of truth: when a tool name has both
/// a native executor and a frontend bridge fallback, the native
/// executor wins. The bridge is preserved only for tool names the
/// Rust registry doesn't know — primarily MCP tools (`mcp_*`) which
/// are still discovered + executed on the frontend.
///
/// `supports_vision` gates image-returning tools
/// ([`crate::tools::browser::VISION_REQUIRED_TOOLS`]): when the active
/// model can't see images, those tools are left out of the per-turn
/// registry entirely, so they're neither advertised to nor callable by
/// the model. This is the Rust-side port of the old frontend vision
/// gate, which stopped working once the Rust registry began advertising
/// native tools directly.
pub(super) fn build_per_turn_tool_registry(
    base: Arc<ToolRegistry>,
    tools: &[AllowedTool],
    turn_id: String,
    router: Arc<BridgeRouter>,
    emitter: Arc<dyn BridgeEmitter>,
    cancel_token: CancellationToken,
    supports_vision: bool,
    execution_mode: AgentExecutionMode,
    workspace_path: Option<&str>,
    chapters_enabled: bool,
    browser_enabled: bool,
    // Hold deferrable tools out of the roster and advertise `tool_search`
    // instead. `false` reproduces the previous behaviour exactly: every tool is
    // registered up front and no `tool_search` entry is added.
    defer_tools: bool,
) -> ToolRegistry {
    let registry = ToolRegistry::new();
    // Deferrable tools, built exactly as if they were being registered — the
    // catalogue holds the real executor, so a tool loaded later keeps its
    // permission gate (native) or its bridge routing (MCP).
    let mut deferred: Vec<Arc<dyn ToolExecutor>> = Vec::new();
    let vision_blocked = |name: &str| {
        !supports_vision && crate::tools::browser::VISION_REQUIRED_TOOLS.contains(&name)
    };
    // Resolved once per turn: `plan_store::active` walks the plans directory,
    // and the answer cannot change mid-registry-build.
    let has_plan = workspace_has_plan(workspace_path);
    let mode_blocked = |name: &str| {
        !is_tool_available_this_turn(
            name,
            execution_mode,
            has_plan,
            chapters_enabled,
            browser_enabled,
        )
    };
    // 1. Bridge fallback for every AllowedTool the model can see.
    for tool in tools {
        if vision_blocked(&tool.name) || is_withdrawn_tool(&tool.name) || mode_blocked(&tool.name) {
            continue;
        }
        let executor: Arc<dyn ToolExecutor> = Arc::new(FrontendBridgeExecutor::new(
            tool.clone(),
            turn_id.clone(),
            router.clone(),
            emitter.clone(),
            cancel_token.clone(),
        ));
        if defer_tools && is_deferrable(&tool.name) {
            defer(&mut deferred, executor);
        } else {
            registry.register(executor);
        }
    }
    // 2. Native Rust executors from the base registry overwrite any
    //    bridge entry registered above with the same name.
    for name in base.names() {
        if vision_blocked(&name) || is_withdrawn_tool(&name) || mode_blocked(&name) {
            continue;
        }
        if let Some(existing) = base.get(&name) {
            let executor: Arc<dyn ToolExecutor> =
                if execution_mode == AgentExecutionMode::Plan && name == "shell_execute" {
                    Arc::new(PlanShellExecutor { inner: existing })
                } else {
                    existing
                };
            if defer_tools && is_deferrable(&name) {
                defer(&mut deferred, executor);
            } else {
                registry.register(executor);
            }
        }
    }
    // 3. One entry standing in for the whole deferred catalogue. Registered
    //    LAST so it never displaces a real tool's roster position, and only
    //    when something was actually held back — a `tool_search` advertising an
    //    empty catalogue is a schema the model can only waste a call on.
    //
    //    The executor holds a CLONE of this registry, which shares the same
    //    map: loading a tool mutates the roster the next request is built from,
    //    because `ConversationRuntime` re-reads `schemas()` every iteration.
    if !deferred.is_empty() {
        registry.register(Arc::new(ToolSearchExecutor::new(
            deferred,
            registry.clone(),
        )));
    }
    registry
}

/// Tools withdrawn from the model's roster entirely.
///
/// Filtered here as well as at the registration site because the frontend
/// supplies its own `AllowedTool` list; without this, a stale frontend entry
/// would quietly re-introduce the tool as a bridge executor.
///
/// `editor_open_file` was withdrawn when file opening moved to the Agent
/// Window's right rail — the model no longer drives the IDE's editor.
pub(super) const WITHDRAWN_TOOLS: &[&str] = &["editor_open_file"];

pub(super) fn is_withdrawn_tool(name: &str) -> bool {
    WITHDRAWN_TOOLS.contains(&name)
}

/// Tools withheld from the model in Plan mode.
///
/// This is the authoritative gate — the registry the model actually sees is
/// built here, so the TypeScript filter in `agent-execution-mode.ts` governs
/// only the frontend's own view and cannot substitute for this list.
///
/// `plan_write` is deliberately absent: authoring the plan document is the one
/// permitted write in Plan mode. `plan_step_update` IS listed, because marking
/// real progress belongs to execution, not planning.
pub(super) const PLAN_MUTATING_TOOLS: &[&str] = &[
    "file_write",
    "file_edit",
    "move_path",
    "delete_path",
    "folder_create",
    "shell_spawn",
    "shell_kill",
    // The checklist is an execution artifact. `todo` is one tool with a typed
    // `op`, so read cannot be separated from set/update by name — and Plan mode
    // has nothing to read: it authors the plan, it does not work a checklist.
    "todo",
    "plan_step_update",
];

pub(super) fn is_plan_mutating_tool(name: &str) -> bool {
    PLAN_MUTATING_TOOLS.contains(&name)
}

/// Is this tool available for the turn about to run?
///
/// Mode gating and plan-presence gating in one place, because splitting them is
/// what let `plan_write` stay callable in Agent mode while the prompt told the
/// model it could not author plans there.
///
/// A plan is a Plan-mode artifact for a specific project, so the plan toolset is
/// withheld unless a plan is actually in play. Advertising `plan_read` /
/// `plan_step_update` in every Agent-mode turn of every project tells the model
/// a plan system exists when there is nothing to read and nothing to mark.
pub(super) fn is_tool_available_this_turn(
    name: &str,
    execution_mode: AgentExecutionMode,
    has_plan: bool,
    chapters_enabled: bool,
    browser_enabled: bool,
) -> bool {
    let planning = execution_mode == AgentExecutionMode::Plan;
    if planning && is_plan_mutating_tool(name) {
        return false;
    }
    match name {
        // Authoring the plan is Plan mode's one write, and ONLY Plan mode's.
        // Executing a plan must not silently rewrite what the user approved.
        "plan_write" => planning,
        // Nothing to read or mark until a plan exists. In Plan mode the tool
        // stays available so the agent can re-read a plan it is revising.
        "plan_read" | "plan_step_update" => planning || has_plan,
        // Chapters are opt-in. Gated in the same place as the instruction that
        // teaches them (see `agent-prompt.ts`) and driven by the same preference
        // read, so the model is never told to announce chapters without the tool
        // to do it — or handed the tool with nothing telling it when to call.
        "chapter" => chapters_enabled,
        // The whole browser bucket rides one switch. 16 schemas, ~2,800
        // tokens on every request, and only Anthropic gets a `cache_control`
        // marker from Aurora — so on every other provider that is paid in
        // full on turns that never open a page.
        _ if name.starts_with("browser_") => browser_enabled,
        _ => true,
    }
}

/// Does this workspace have a plan to work against?
///
/// Errors (unreadable dir, malformed document) resolve to "no plan": losing a
/// tool is recoverable, and failing the whole turn over plan bookkeeping is not.
pub(super) fn workspace_has_plan(workspace: Option<&str>) -> bool {
    workspace
        .map(std::path::Path::new)
        .and_then(|root| crate::plans::store::active(root).ok().flatten())
        .is_some()
}

pub(super) struct PlanShellExecutor {
    inner: Arc<dyn ToolExecutor>,
}

#[async_trait::async_trait]
impl ToolExecutor for PlanShellExecutor {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> crate::agent_runtime::api_client::ToolSchema {
        self.inner.schema()
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        context: &ToolContext,
    ) -> Result<String, ToolError> {
        let command = input
            .get("command")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ToolError::InvalidInput("`command` must be a non-empty string".into())
            })?;
        if !is_plan_shell_command_allowed(command) {
            return Err(ToolError::PolicyViolation(
                "Plan mode allows one read-only shell command at a time; use Agent mode for writes, pipelines, or chained commands"
                    .into(),
            ));
        }
        // Validate against the shell the command will run in — a PowerShell
        // or cmd write is invisible to the POSIX read-only rules.
        let requested_shell = input.get("shell").and_then(serde_json::Value::as_str);
        crate::agent_safety::shell_validation::validate_for_shell(
            command,
            ExecutionMode::ReadOnly,
            crate::shell::resolve_kind(requested_shell),
            None,
        )
        .map_err(|error| {
            ToolError::PolicyViolation(format!(
                "Plan mode allows read-only shell commands only: {error}"
            ))
        })?;
        self.inner.execute(input, context).await
    }
}

pub(super) fn is_plan_shell_command_allowed(command: &str) -> bool {
    if command.trim().is_empty()
        || [';', '|', '>', '<', '&', '\n', '\r', '`']
            .iter()
            .any(|token| command.contains(*token))
        || command.contains("$(")
    {
        return false;
    }

    let normalized = command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if normalized.contains("--output") || normalized.contains(" -o ") {
        return false;
    }
    let simple = [
        "cat",
        "cd",
        "dir",
        "echo",
        "findstr",
        "get-childitem",
        "get-command",
        "get-content",
        "get-item",
        "get-location",
        "get-process",
        "grep",
        "ls",
        "pwd",
        "resolve-path",
        "rg",
        "select-string",
        "test-path",
        "type",
        "where",
        "whoami",
    ];
    if simple
        .iter()
        .any(|allowed| normalized == *allowed || normalized.starts_with(&format!("{allowed} ")))
    {
        return true;
    }

    ["git diff", "git log", "git show", "git status"]
        .iter()
        .any(|allowed| normalized == *allowed || normalized.starts_with(&format!("{allowed} ")))
        || is_read_only_git_branch(&normalized)
}

pub(super) fn is_read_only_git_branch(command: &str) -> bool {
    if command == "git branch" {
        return true;
    }
    let Some(args) = command.strip_prefix("git branch ") else {
        return false;
    };
    let flags: Vec<&str> = args.split_whitespace().collect();
    flags.iter().all(|arg| arg.starts_with('-'))
        && !flags.iter().any(|arg| {
            matches!(
                *arg,
                "-d" | "-D" | "-m" | "-M" | "-c" | "-C" | "--delete" | "--move" | "--copy"
            ) || arg.starts_with("--delete=")
                || arg.starts_with("--move=")
                || arg.starts_with("--copy=")
        })
}
