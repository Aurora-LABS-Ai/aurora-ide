//! Agent runtime IPC — What the model is allowed to call this turn: the per-turn registry, the
//! withdrawn roster, plan-mode gating, and the plan-mode shell allow-list.
//!
//! Split out of `agent_v2.rs` verbatim; see `mod.rs` for the map.

use super::*;

/// Optional capabilities use discovery; core tools remain directly advertised.
/// Files, search, shell, tasks, and skills are needed frequently enough that
/// requiring an extra discovery round trip would slow ordinary coding work.
pub(super) fn is_deferrable(name: &str) -> bool {
    name.starts_with("mcp_") || name.starts_with("browser_") || name.starts_with("team_")
}

/// Add an already-guarded executor with registry-compatible name precedence.
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

/// Build a per-turn registry from native executors, then add frontend bridge
/// fallbacks for names Rust does not own. Partition only after availability
/// filtering, so direct calls and discovered calls obey the same policy.
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
    // Accepted for older clients; optional tools now always use static wrappers.
    _defer_tools: bool,
    _thread_id: &str,
) -> ToolRegistry {
    let registry = ToolRegistry::new();
    // Chat mode has no workspace, and the plan lookup below walks one.
    let workspace_path = if execution_mode.has_workspace() {
        workspace_path
    } else {
        None
    };
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
    // 1. Native Rust executors first, in the base registry's own stable
    //    registration order.
    //
    //    Order is a CACHE decision, not a cosmetic one. The serialized tool
    //    array rides in every request's cacheable prefix, and providers cache
    //    on the longest common prefix, so whatever sits at the head has to be
    //    byte-identical between turns. Bridged tools used to register first,
    //    and because `ToolRegistry::register` keeps an existing name's slot,
    //    a native tool inherited whichever position its bridge placeholder
    //    happened to land in. One MCP server connecting reshuffled the head
    //    and cost the entire tool block. Natives are now a contiguous prefix
    //    and MCP churn can only move the tail.
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
            if is_deferrable(&name) {
                defer(&mut deferred, executor);
            } else {
                registry.register(executor);
            }
        }
    }
    // 2. Bridge fallback for every AllowedTool the Rust registry does NOT
    //    know — primarily `mcp_*`, plus team/skill/question tools.
    //
    //    Sorted by name so the partition is a function of WHICH servers are
    //    connected and never of the order they happened to connect in. Two
    //    turns with the same server set now serialize identically.
    let mut bridged: Vec<&AllowedTool> = tools
        .iter()
        .filter(|tool| base.get(&tool.name).is_none())
        .collect();
    bridged.sort_by(|a, b| a.name.cmp(&b.name));
    for tool in bridged {
        if vision_blocked(&tool.name) || is_withdrawn_tool(&tool.name) || mode_blocked(&tool.name) {
            continue;
        }
        // Bridge executors are built fresh for every turn, so they never pass
        // through the registry-wide `install_timeout_guards` that bounds the
        // native tools at startup. Wrap them here or they are the one family
        // that can still wait forever.
        let executor: Arc<dyn ToolExecutor> =
            crate::tools::timeout::TimeoutGuardedExecutor::maybe_wrap(Arc::new(
                FrontendBridgeExecutor::new(
                    tool.clone(),
                    turn_id.clone(),
                    router.clone(),
                    emitter.clone(),
                    cancel_token.clone(),
                ),
            ));
        if is_deferrable(&tool.name) {
            defer(&mut deferred, executor);
        } else {
            registry.register(executor);
        }
    }
    // These definitions stay present even when no optional tools are connected.
    // Catalog changes on later turns affect search results, never this prefix.
    crate::tools::tool_search::install(&registry, deferred);
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
pub(super) const WITHDRAWN_TOOLS: &[&str] = &["editor_open_file", "tool_search", "call_tool"];

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
    // The checklist is an execution artifact: Plan mode authors the plan, it
    // does not work a checklist. All three go, `TaskList` included — a read
    // that can only ever return the empty list is a tool the model is told
    // exists for nothing.
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
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
    // Chat mode answers first, and it answers by ALLOW-LIST. Everything below
    // this point is a deny-list over the project roster, and a deny-list is the
    // wrong instrument here: it is only correct for the tools that existed when
    // it was written, so the next tool anyone adds is available in chat mode by
    // default and nobody finds out until it runs.
    if execution_mode.is_chat() {
        return is_chat_mode_tool(name);
    }
    let planning = execution_mode == AgentExecutionMode::Plan;
    if planning && is_plan_mutating_tool(name) {
        return false;
    }
    match name {
        // Chat's memory is Chat's alone, and this arm is the half that was
        // missing. `CHAT_MODE_TOOLS` says what Chat may call; it says nothing
        // about the other direction, so every non-chat mode fell straight
        // through to `_ => true` and Aurora Build was handed `recall` and
        // `remember` on every turn. Observed: a Build turn called `recall`
        // beside `shell_execute`, got `found: 0` — the index holds Chat
        // conversations only — and reported to the user that its memory was
        // empty, when it had simply asked a store that is not about it.
        //
        // The comment at `tools/mod.rs` ("always registered, offered only in
        // chat") described this arm before this arm existed.
        _ if is_chat_only_tool(name) => false,
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
        // Disabling browser access removes the whole optional bucket.
        _ if name.starts_with("browser_") => browser_enabled,
        _ => true,
    }
}

/// Aurora Chat's entire native tool roster, by name.
///
/// This list IS the promise. Chat mode has no files, no shell and no workspace,
/// and the way that stays true as Aurora grows is that a tool is absent here
/// until somebody adds it here on purpose. Subtracting from the project roster
/// instead would mean every future tool ships into chat mode by accident.
///
/// MCP is not in this list and is not meant to be: it is matched by prefix in
/// [`is_chat_mode_tool`] because the user connecting a server IS the grant, and
/// its tools are deferred behind `tool_search` so a server connected halfway
/// through a conversation is still reachable.
pub(super) const CHAT_MODE_TOOLS: &[&str] = &[
    // Research.
    "auroro_websearch",
    // Presentation. Artifacts are compiled/rendered before they save, so a
    // broken canvas is rejected at write time rather than at read time.
    "present_artifact",
    "read_artifact",
    // …and the contract those canvases are written against. Chat could build a
    // live canvas and had no way to read the rules for one: measured on a real
    // chat, a benchmark comparison came back with five hand-picked hues — one
    // per model — where the doctrine's whole colour system is `tone`
    // (`neutral | info | good | warn | bad`) and the answer was a single
    // highlighted series against neutral bars. A tool the roster withholds is a
    // rule the model cannot follow.
    "canvas_guidelines",
    // Memory. `recall` reads, `remember` writes; both are scoped to chats and
    // cannot reach `sessions/`.
    "recall",
    "remember",
    // Images.
    "generate_image",
    // Asking the user a question is not a capability, it is a conversation.
    "ask_question",
];

/// Is `name` callable in Aurora Chat?
///
/// Exact match against [`CHAT_MODE_TOOLS`], plus the `mcp_` prefix. Nothing
/// else, and deliberately no `starts_with` conveniences: a prefix rule is how
/// an allow-list quietly becomes a deny-list.
pub(super) fn is_chat_mode_tool(name: &str) -> bool {
    CHAT_MODE_TOOLS.contains(&name) || name.starts_with("mcp_")
}

/// Tools that exist in Aurora Chat and NOWHERE else.
///
/// [`CHAT_MODE_TOOLS`] is an allow-list for one mode; most of what is on it —
/// web search, artifacts, images, asking a question — is equally a Build tool
/// and stays available there. These two are not. `recall` and `remember` read
/// and write the chat memory index, which carries Aurora Chat conversations
/// only, so offering them to Build gives the model a memory that is
/// structurally empty of everything Build ever did.
pub(super) const CHAT_ONLY_TOOLS: &[&str] = &["recall", "remember"];

pub(super) fn is_chat_only_tool(name: &str) -> bool {
    CHAT_ONLY_TOOLS.contains(&name)
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

    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        self.inner.timeout_policy()
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
