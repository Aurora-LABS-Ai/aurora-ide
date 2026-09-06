//! Tool executor abstraction — Phase 2.1 surface.
//!
//! Every tool the agent can call is an `Arc<dyn ToolExecutor>` registered
//! in a [`ToolRegistry`]. The conversation runtime looks up tools by
//! name when the model emits a [`ContentBlock::ToolUse`] block, calls
//! [`ToolExecutor::execute`], and feeds the resulting `String` back into
//! the next turn as a [`ContentBlock::ToolResult`].
//!
//! Phase 2.1 lands the **trait surface and registry** only. The 24+
//! concrete tool implementations (file ops, shell, search, todo, …)
//! get ported in Phase 3 — those are the executors today living under
//! `src/tools/executors/` in TypeScript.
//!
//! Design notes:
//!
//! - **Async.** Tools may shell out, hit the disk, or wait on the
//!   pending-changes UI; blocking the runtime task is unacceptable.
//! - **`Send + Sync`.** Registry is shared across tasks; Tauri's IPC
//!   handlers run on a multi-thread tokio scheduler.
//! - **Cancellation.** `ToolContext::cancel_token` is a child of the
//!   runtime's cancel token. Long-running tools (shell_execute, grep,
//!   semantic_search) MUST `tokio::select!` against it.
//! - **`String` return type, not `Value`.** The Anthropic API model
//!   carries tool results as strings (`content` field on
//!   `ToolResult`). Tools that have structured output stringify it
//!   themselves — usually as JSON. Letting the trait return `Value`
//!   would bake serialization into the trait surface and fight every
//!   provider.
//!
//! [`ContentBlock::ToolUse`]: super::types::ContentBlock::ToolUse
//! [`ContentBlock::ToolResult`]: super::types::ContentBlock::ToolResult

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::api_client::ToolSchema;

/// How far outside the open project a turn's file tools may reach.
///
/// One setting, three states, because two booleans would admit a fourth that
/// means nothing ("may write outside, may not read outside"). Chosen by the
/// user in Settings → Agent and carried unchanged from the request to every
/// [`ToolContext`]; it is read once per turn, so flipping it mid-turn affects
/// the next one.
///
/// It governs the FILE tools only. `shell_execute` accepts an absolute `cwd`
/// in every mode — its gate is command validation plus the approval modal, not
/// this. A mode named for the file boundary should not quietly claim to be a
/// sandbox.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAccess {
    /// The project and nothing else. Every path — read, search, or write —
    /// resolves inside the workspace root or is refused.
    #[default]
    Workspace,
    /// Reads may leave. `file_read`, `multi_file_read` and `workspace_tree`
    /// take an absolute path anywhere on disk; searching still stops at the
    /// project edge, and every write stays inside it.
    Read,
    /// No path boundary. Reads, searches, and writes all resolve anywhere the
    /// OS allows — the state for working across two checkouts, a global config,
    /// or a dependency's source.
    ///
    /// The approval gate is untouched and does the guarding here:
    /// `file_write`, `delete_path` and `shell_execute` all return
    /// `requires_permission() == true`, and a tool with no explicit setting is
    /// `always_ask`. Someone who has ALSO set those to `auto` has turned off
    /// both layers deliberately.
    Full,
}

impl WorkspaceAccess {
    /// Reading and mapping a path outside the workspace.
    #[must_use]
    pub fn reads_outside(self) -> bool {
        matches!(self, Self::Read | Self::Full)
    }

    /// The path boundary is gone entirely. Only [`Self::Full`] does this, and
    /// the two predicates below are named views of it so a call site reads as
    /// what it is doing rather than as a mode comparison.
    #[must_use]
    pub fn lifts_boundary(self) -> bool {
        matches!(self, Self::Full)
    }

    /// Searching outside the workspace — `grep`, `glob`, and any other tool
    /// that walks a tree it was handed rather than opening one named file.
    ///
    /// Deliberately NOT granted by [`Self::Read`]. That mode exists for "read
    /// this one file I am pointing at"; letting it walk arbitrary trees turns
    /// a targeted allowance into a filesystem crawl.
    #[must_use]
    pub fn searches_outside(self) -> bool {
        self.lifts_boundary()
    }

    /// Creating, writing, moving, or deleting outside the workspace.
    ///
    /// [`Self::Read`] does not grant it, and that is the whole point of having
    /// a middle mode: pointing the agent at a file to read is a smaller
    /// decision than letting it change one.
    #[must_use]
    pub fn writes_outside(self) -> bool {
        self.lifts_boundary()
    }

    /// Resolve the wire's two spellings into one value.
    ///
    /// `mode` is what the app sends today. `legacy_allow` is the boolean this
    /// setting used to be: an install that never opened Settings after
    /// upgrading still has only `allowOutsideWorkspace` on disk, and dropping
    /// it would silently re-fence an agent the user had already let out.
    #[must_use]
    pub fn from_wire(mode: Option<&str>, legacy_allow: Option<bool>) -> Self {
        match mode.map(str::trim) {
            Some("full") => Self::Full,
            Some("read") => Self::Read,
            Some("workspace") => Self::Workspace,
            // An unknown mode is not a reason to widen access.
            _ => {
                if legacy_allow.unwrap_or(false) {
                    Self::Read
                } else {
                    Self::Workspace
                }
            }
        }
    }
}

/// Per-execution context handed to a tool's `execute` call.
///
/// Carries enough identity for logging/tracing (`turn_id`, `tool_call_id`,
/// `thread_id`), the workspace root every file-touching tool resolves paths
/// against, how far outside it they may reach, and the cancel token tied to
/// the surrounding turn.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub turn_id: String,
    pub tool_call_id: String,
    /// The CONVERSATION this call belongs to — the same id the frontend
    /// knows the thread by, and the key for every piece of durable
    /// per-conversation state a tool owns.
    ///
    /// This field was `session_id`, filled from `Session::session_id`, which
    /// is a fresh UUIDv4 on every load and is documented as distinct from the
    /// thread. Nothing in the tool layer ever wanted that: the todo sidecar,
    /// a plan step's run claim, and background-process logs are all
    /// per-conversation, so they were written under an id that changed each
    /// restart and broadcast to a UI that filed them under a thread nobody
    /// was looking at. Renamed rather than reassigned so it cannot be
    /// misread the same way twice.
    pub thread_id: String,
    pub workspace_root: Option<PathBuf>,
    /// How far outside the workspace this turn's file tools may reach — the
    /// user's choice in Settings → Agent. See [`WorkspaceAccess`].
    pub workspace_access: WorkspaceAccess,
    /// This thread's `…/<thread_id>.tool-results` directory, when the runtime
    /// has a session store.
    ///
    /// Reads inside it are permitted even with `allow_outside_workspace`
    /// false. That directory holds nothing but output THIS agent just
    /// produced: when a command prints more than fits in context,
    /// [`crate::agent_runtime::tool_spill`] writes the full text there and
    /// hands the model a head+tail preview plus the path, telling it to open
    /// the rest with `file_read`.
    ///
    /// Without this the instruction was a dead end in the default
    /// configuration — the file sits under `%LOCALAPPDATA%`, so the boundary
    /// check refused it and the agent was pointed at output it could not
    /// reach. The setting exists to keep the agent out of the user's wider
    /// filesystem; it was never meant to hide the agent's own spilled stdout
    /// from it.
    pub spill_dir: Option<PathBuf>,
    pub cancel_token: CancellationToken,
}

impl ToolContext {
    /// Convenience: short-circuit a tool's body if the turn was
    /// already cancelled before the tool was reached.
    ///
    /// ```ignore
    /// async fn execute(&self, …, ctx: &ToolContext) -> Result<…> {
    ///     ctx.bail_if_cancelled()?;
    ///     // …expensive work…
    /// }
    /// ```
    pub fn bail_if_cancelled(&self) -> Result<(), ToolError> {
        if self.cancel_token.is_cancelled() {
            Err(ToolError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Errors raised by [`ToolExecutor::execute`].
///
/// The variants are deliberately coarse — they map onto the
/// `is_error` flag on a [`ContentBlock::ToolResult`], which is just a
/// boolean. The runtime stringifies the error via `Display` and uses
/// it as the result `content` so the model can see what went wrong.
///
/// All variants are `Clone` so the runtime can keep one for its own
/// telemetry while propagating another up.
///
/// [`ContentBlock::ToolResult`]: super::types::ContentBlock::ToolResult
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ToolError {
    #[error("tool not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// The model's tool-call arguments never parsed as a JSON object, so
    /// no executor ever saw them.
    ///
    /// Distinct from [`InvalidInput`] on purpose: `InvalidInput` means the
    /// arguments arrived intact and failed the tool's own contract
    /// ("`path` is required"), whereas this means the arguments were
    /// destroyed in transit — truncated by an output cap, mangled by a bad
    /// escape, or emitted as something other than an object. Telling a
    /// model "`path` is required" when it *did* send `path` is what turns
    /// one bad block into five wasted iterations, so the two must never
    /// collapse into the same message.
    ///
    /// [`InvalidInput`]: Self::InvalidInput
    #[error("malformed tool arguments: {0}")]
    MalformedInput(String),

    #[error("execution failed: {0}")]
    Execution(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// A policy gate (workspace boundary, allow-list, etc.) refused the
    /// call. Distinct from [`PermissionDenied`] (interactive user
    /// rejection) and [`PathEscape`] (specifically a path-traversal
    /// outside the workspace) — `PolicyViolation` is the catch-all the
    /// Phase 3 file/workspace/search executors map every
    /// `agent_safety::PathSafetyError` onto.
    #[error("policy violation: {0}")]
    PolicyViolation(String),

    #[error("path is outside the workspace: {0}")]
    PathEscape(String),

    #[error("tool was cancelled")]
    Cancelled,

    /// The call was abandoned after `timeout_ms` without an answer.
    ///
    /// `message` carries the whole sentence the model reads, built by
    /// [`crate::tools::timeout::TimeoutPolicy::timed_out_message`], because the
    /// useful half of a timeout is per-tool advice ("raise `timeout`", "the
    /// browser panel stopped answering") and a bare duration cannot carry it.
    /// `timeout_ms` stays a field so a caller can classify the failure without
    /// parsing prose.
    #[error("{message}")]
    Timeout { timeout_ms: u64, message: String },
}

/// Anything the agent can call.
///
/// Implementors must be cheap to clone behind `Arc` and re-entrant —
/// the runtime may invoke the same registered tool multiple times
/// concurrently across distinct turns.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Tool name as the model sees it. Must match the `name` field of
    /// the [`ToolSchema`] returned by `schema()`. Conventional kebab/
    /// snake-case (`"shell_execute"`, `"file_read"`).
    fn name(&self) -> &str;

    /// Schema published to the model. Re-built on demand because
    /// some tools want to reflect workspace state into their schema
    /// (e.g. ignored-paths-aware glob roots).
    fn schema(&self) -> ToolSchema;

    /// Run the tool. `input` is the raw JSON the model emitted —
    /// implementations are expected to validate it themselves and
    /// return [`ToolError::InvalidInput`] on a shape mismatch.
    async fn execute(
        &self,
        input: serde_json::Value,
        context: &ToolContext,
    ) -> Result<String, ToolError>;

    /// Whether this tool needs to consult the [`Permitter`] (Phase 4)
    /// before each invocation. Defaults to `false` so existing tools
    /// stay unchanged; the Phase 3 shell + destructive file/folder
    /// executors override to `true`.
    ///
    /// The dispatch site is [`ToolRegistry::execute_with_permission`];
    /// the legacy `get(name).execute(...)` path used by the existing
    /// `ConversationRuntime` ignores this flag entirely (it's the
    /// gate-free fast path that Phase 2.3 tests cover).
    fn requires_permission(&self) -> bool {
        false
    }

    /// Whether this tool may run **concurrently** with its neighbours in
    /// the same batch of tool calls.
    ///
    /// Models routinely emit several independent reads in one message;
    /// running them one at a time turns a single round-trip into six.
    /// [`crate::agent_runtime::conversation`] runs maximal runs of
    /// concurrency-safe calls together and keeps everything else strictly
    /// sequential.
    ///
    /// Defaults to `false` — the safe answer. Override to `true` only when
    /// the tool: observes workspace state without mutating it, needs no
    /// permission prompt (prompts must be answered one at a time), and
    /// contends for no single shared resource. That last clause is why the
    /// read-only browser tools stay `false`: there is exactly one browser
    /// panel, and two "read-only" calls against it can still interleave a
    /// navigation.
    fn concurrency_safe(&self) -> bool {
        false
    }

    /// Whether this executor already reports execution start/result to
    /// the frontend through a separate channel.
    ///
    /// Native Rust executors return `false` and let
    /// [`crate::agent_runtime::conversation::ConversationRuntime`]
    /// emit `tool_execution_start` / `tool_execution_result` events.
    /// Frontend bridge executors return `true` because the TypeScript
    /// bridge owns the MCP execution lifecycle and would otherwise
    /// produce duplicate UI updates.
    fn uses_frontend_lifecycle(&self) -> bool {
        false
    }

    /// How long this tool may take, when something has to stop it from
    /// outside.
    ///
    /// `None` — the default — means one of two things, and both are fine:
    /// the tool cannot wait at all (a JSON read, a guidelines string), or it
    /// bounds itself internally and does it better than an outside clock
    /// could. `shell_execute` is the second kind: it kills its own process and
    /// keeps whatever the command printed first, whereas an outside timeout
    /// would abandon the call and throw that output away.
    ///
    /// `Some(policy)` opts the tool into
    /// [`crate::tools::timeout::TimeoutGuardedExecutor`], installed over the
    /// whole registry by
    /// [`crate::tools::timeout::install_timeout_guards`]. A wrapper executor
    /// must forward this from its inner tool or the bound is silently lost.
    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        None
    }
}

// ---------------------------------------------------------------------------
// Phase 4 — permission prompter trait
// ---------------------------------------------------------------------------

/// Optional gate consulted by [`ToolRegistry::execute_with_permission`]
/// before every tool whose [`ToolExecutor::requires_permission`]
/// returns `true`.
///
/// Phase 4 ships this surface only — production wiring of the Tauri
/// modal happens in the parent agent's final 10%. Until then, the
/// runtime never sets a [`Permitter`] on its [`ToolRegistry`], so
/// every tool runs through the gate-free legacy dispatch path.
///
/// A concrete production impl ([`crate::tools::permissions::TauriPermitter`])
/// emits an `agent_permission_request` Tauri event and parks on a
/// oneshot until the frontend posts a verdict via the
/// `agent_grant_permission` command. Tests use the in-memory
/// [`crate::tools::permissions::MockPermitter`] which decides
/// synchronously.
///
/// `cancel` is the same per-turn token the executor will see — the
/// permitter MUST `tokio::select!` against it so a mid-prompt cancel
/// short-circuits with [`ToolError::Cancelled`] instead of waiting on
/// the user.
#[async_trait]
pub trait Permitter: Send + Sync + 'static {
    /// Request approval for a single tool call.
    ///
    /// `tool_use_id` is the **provider-issued** id for this specific
    /// invocation (Anthropic `toolu_…`, OpenAI `call_…`, etc.). The
    /// Tauri permitter forwards this to the frontend so the chat UI's
    /// inline approval card — keyed on the same id as the streaming
    /// tool card — can render attached to the correct tool. Don't use
    /// it as a router key (router still keys on `(turn_id,
    /// tool_name)`); it's a UI correlation id only.
    async fn request(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<bool, ToolError>;
}

/// Concurrent name → executor map.
///
/// Cloning the registry is cheap: it's an `Arc<DashMap>` under the
/// hood. The runtime holds one `Arc<ToolRegistry>` per `ConversationRuntime`
/// instance and shares it across turns.
///
/// Phase 4 adds an optional [`Permitter`] field. When set,
/// [`ToolRegistry::execute_with_permission`] consults it before
/// dispatching tools that opt in via
/// [`ToolExecutor::requires_permission`]. The legacy
/// `get(name).execute(...)` path used by `ConversationRuntime` is
/// untouched — production runtime keeps the gate-free path until the
/// parent agent flips the switch.
/// Maximum number of tool names listed in an unknown-tool error before
/// the roster is summarized instead. Aurora ships 23 builtins; a workspace
/// with several MCP servers connected can push the total past 100, and a
/// 100-name list costs more context than it recovers.
const MAX_LISTED_TOOLS: usize = 60;

#[derive(Clone, Default)]
pub struct ToolRegistry {
    /// Name → (registration index, executor).
    ///
    /// The index exists because `DashMap` iteration order is arbitrary and
    /// re-randomizes per process. The schema list built from it is part of
    /// every request's cacheable prefix, so an unstable order defeats
    /// provider prompt caching outright — and tool ordering measurably
    /// shifts which tool a model reaches for. Registration order is stable,
    /// meaningful (bucket by bucket), and survives re-registration.
    tools: Arc<DashMap<String, (usize, Arc<dyn ToolExecutor>)>>,
    /// Monotonic source for the registration index above.
    next_order: Arc<std::sync::atomic::AtomicUsize>,
    /// Phase 4 permission gate. `None` (the default) means
    /// `execute_with_permission` runs every tool unconditionally —
    /// that's the behavior the Phase 2.3 tests assume.
    permitter: Option<Arc<dyn Permitter>>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("tool_count", &self.tools.len())
            .field("has_permitter", &self.permitter.is_some())
            .finish()
    }
}

impl ToolRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tool. Re-registering the same name overwrites the
    /// executor but **keeps its original position** in the roster, so
    /// decorating a tool in place (as `install_permission_gate` does)
    /// cannot reshuffle the schema list and invalidate a cached prefix.
    pub fn register(&self, executor: Arc<dyn ToolExecutor>) {
        use std::sync::atomic::Ordering;

        let name = executor.name().to_string();
        let order = self
            .tools
            .get(&name)
            .map_or_else(|| self.next_order.fetch_add(1, Ordering::Relaxed), |e| e.0);
        self.tools.insert(name, (order, executor));
    }

    /// Look up a tool by name. Returns `None` if not registered.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Arc<dyn ToolExecutor>> {
        self.tools.get(name).map(|e| e.value().1.clone())
    }

    /// Every registered executor in stable registration order.
    fn ordered(&self) -> Vec<(usize, Arc<dyn ToolExecutor>)> {
        let mut entries: Vec<(usize, Arc<dyn ToolExecutor>)> = self
            .tools
            .iter()
            .map(|e| (e.value().0, e.value().1.clone()))
            .collect();
        entries.sort_by_key(|(order, _)| *order);
        entries
    }

    /// Snapshot every registered tool's schema, in stable registration
    /// order. The returned `Vec` is what the runtime hands to
    /// [`super::api_client::ApiRequest::tools`] on every iteration — it
    /// must be byte-identical between requests or provider prompt caching
    /// never hits.
    #[must_use]
    pub fn schemas(&self) -> Vec<ToolSchema> {
        self.ordered()
            .into_iter()
            .map(|(_, executor)| executor.schema())
            .collect()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Names of every registered tool, in stable registration order.
    /// Used for diagnostics, the audit log, and the roster an unknown-tool
    /// error hands back to the model.
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.ordered()
            .into_iter()
            .map(|(_, executor)| executor.name().to_string())
            .collect()
    }

    /// Build the error for a tool name that isn't registered.
    ///
    /// A bare `tool not found: browser_eval` is a dead end — the model's
    /// only move is to guess again, and repeated guessing is how a turn
    /// burns its iteration budget on a name. This attaches the two things
    /// that make the miss recoverable in a single step: the nearest
    /// registered name (when one is genuinely close) and the real roster.
    ///
    /// It also removes the need to enumerate withdrawn tools in the system
    /// prompt and ask the model not to call them. A prompt cannot enforce
    /// a roster; the error can, and it arrives exactly when it's relevant.
    #[must_use]
    pub fn unknown_tool_error(&self, name: &str) -> ToolError {
        let available = self.names();
        let suggestion = super::tool_suggest::suggest(name, available.iter().map(String::as_str));

        let mut message = name.to_string();
        if let Some(best) = suggestion {
            message.push_str(&format!(". Did you mean `{best}`?"));
        }

        if available.is_empty() {
            message.push_str(" No tools are registered for this session.");
        } else if available.len() <= MAX_LISTED_TOOLS {
            message.push_str(&format!(" Available tools: {}.", available.join(", ")));
        } else {
            // Too many to spell out (MCP servers inflate the roster). Give
            // the shape and the same-prefix neighbours, which is what a
            // near-miss on an MCP tool actually needs.
            let prefix = name.split('_').next().unwrap_or(name);
            let related: Vec<&str> = available
                .iter()
                .map(String::as_str)
                .filter(|candidate| candidate.starts_with(prefix))
                .take(20)
                .collect();
            message.push_str(&format!(" {} tools are registered", available.len()));
            if related.is_empty() {
                message.push('.');
            } else {
                message.push_str(&format!(
                    "; those starting `{prefix}`: {}.",
                    related.join(", ")
                ));
            }
        }

        ToolError::NotFound(message)
    }

    // -----------------------------------------------------------------
    // Phase 4 — permission gate
    // -----------------------------------------------------------------

    /// Builder-style setter that attaches an [`Permitter`] to the
    /// registry. Returns `self` for chaining.
    ///
    /// The legacy dispatch path (`get` + `executor.execute(...)`)
    /// ignores this — only [`Self::execute_with_permission`] consults
    /// the gate.
    #[must_use]
    pub fn with_permitter(mut self, permitter: Arc<dyn Permitter>) -> Self {
        self.permitter = Some(permitter);
        self
    }

    /// Whether a permitter is currently attached. Diagnostics only.
    #[must_use]
    pub fn has_permitter(&self) -> bool {
        self.permitter.is_some()
    }

    /// Borrow the attached permitter (if any). Used by integration
    /// glue in Phase 4 wiring; tests use it to assert the registry
    /// keeps the same `Arc<dyn Permitter>` it was given.
    #[must_use]
    pub fn permitter(&self) -> Option<Arc<dyn Permitter>> {
        self.permitter.clone()
    }

    /// Phase 4 dispatch: looks up `name`, optionally consults the
    /// [`Permitter`], then invokes [`ToolExecutor::execute`].
    ///
    /// Behaviour:
    /// 1. Unknown tool → [`ToolError::NotFound`].
    /// 2. Pre-cancelled context → [`ToolError::Cancelled`] (mirrors
    ///    [`FrontendBridgeExecutor::execute`]'s short-circuit and
    ///    saves the permitter a phantom prompt).
    /// 3. `executor.requires_permission() == true` AND a permitter is
    ///    attached: call [`Permitter::request`]. If it returns
    ///    `Ok(false)`, surface [`ToolError::PermissionDenied`]. If it
    ///    returns an error (cancellation, timeout, …), propagate.
    /// 4. Otherwise, dispatch.
    ///
    /// **Additive method.** Existing callers that use
    /// `registry.get(name).unwrap().execute(...)` (notably
    /// [`super::conversation::ConversationRuntime`]) keep their
    /// gate-free behaviour. New callers wired in the Phase 4
    /// integration step get the gate.
    pub async fn execute_with_permission(
        &self,
        name: &str,
        input: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        let executor = self
            .get(name)
            .ok_or_else(|| self.unknown_tool_error(name))?;

        // Cheap pre-check: don't wake the permitter if cancel already
        // fired — same shape as FrontendBridgeExecutor.
        ctx.bail_if_cancelled()?;

        if executor.requires_permission() {
            if let Some(permitter) = &self.permitter {
                let granted = permitter
                    .request(
                        &ctx.turn_id,
                        &ctx.tool_call_id,
                        name,
                        &input,
                        ctx.cancel_token.clone(),
                    )
                    .await?;
                if !granted {
                    return Err(ToolError::PermissionDenied(format!("user denied {name}")));
                }
            }
            // No permitter installed → fall through (the legacy
            // gate-free behaviour). The parent agent flips this on by
            // wiring `with_permitter(...)` in lib.rs.
        }

        executor.execute(input, ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTool;

    #[async_trait]
    impl ToolExecutor for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }

        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: "echo".into(),
                description: "echo input back as text".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "msg": { "type": "string" } },
                    "required": ["msg"],
                }),
            }
        }

        async fn execute(
            &self,
            input: serde_json::Value,
            ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            ctx.bail_if_cancelled()?;
            let msg = input
                .get("msg")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::InvalidInput("missing msg".into()))?;
            Ok(msg.to_string())
        }
    }

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "t-1".into(),
            tool_call_id: "call-1".into(),
            thread_id: "s-1".into(),
            workspace_root: None,
            workspace_access: Default::default(),
            spill_dir: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn echo_tool_executes_and_returns_input() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(EchoTool);
        let result = tool
            .execute(serde_json::json!({ "msg": "hello" }), &ctx())
            .await
            .expect("ok");
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn echo_tool_rejects_missing_input() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(EchoTool);
        let result = tool.execute(serde_json::json!({}), &ctx()).await;
        match result {
            Err(ToolError::InvalidInput(_)) => {}
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancelled_context_short_circuits_execution() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(EchoTool);
        // CancellationToken uses interior mutability — no `&mut` needed.
        let ctx = ctx();
        ctx.cancel_token.cancel();
        let result = tool
            .execute(serde_json::json!({ "msg": "anything" }), &ctx)
            .await;
        match result {
            Err(ToolError::Cancelled) => {}
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }

    #[test]
    fn registry_register_and_get() {
        let reg = ToolRegistry::new();
        assert!(reg.is_empty());

        reg.register(Arc::new(EchoTool));

        assert_eq!(reg.len(), 1);
        let tool = reg.get("echo").expect("echo registered");
        assert_eq!(tool.name(), "echo");
        assert!(reg.get("nonexistent").is_none());
    }

    #[test]
    fn registry_schemas_snapshot_lists_all_tools() {
        let reg = ToolRegistry::new();
        reg.register(Arc::new(EchoTool));
        let schemas = reg.schemas();
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "echo");
    }

    #[test]
    fn registry_re_register_overwrites() {
        let reg = ToolRegistry::new();
        reg.register(Arc::new(EchoTool));
        reg.register(Arc::new(EchoTool));
        assert_eq!(reg.len(), 1, "duplicate names must coalesce");
    }

    /// Minimal named executor for ordering assertions.
    struct NamedTool(&'static str);

    #[async_trait]
    impl ToolExecutor for NamedTool {
        fn name(&self) -> &str {
            self.0
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: self.0.into(),
                description: "test".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }
        }
        async fn execute(
            &self,
            _input: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            Ok(String::new())
        }
    }

    fn registry_of(names: &[&'static str]) -> ToolRegistry {
        let reg = ToolRegistry::new();
        for name in names {
            reg.register(Arc::new(NamedTool(name)));
        }
        reg
    }

    #[test]
    fn schemas_follow_registration_order_not_map_order() {
        // The schema list rides in every request's cacheable prefix. A
        // DashMap-iteration order re-randomizes per process, which defeats
        // prompt caching outright and shifts tool selection.
        let names = ["file_read", "grep", "shell_execute", "TaskUpdate"];
        let reg = registry_of(&names);

        let ordered: Vec<String> = reg.schemas().into_iter().map(|s| s.name).collect();
        assert_eq!(ordered, names);
        assert_eq!(reg.names(), names);

        // Same insertions, same order — every time, in the same process.
        for _ in 0..8 {
            let again = registry_of(&names);
            assert_eq!(again.names(), names);
        }
    }

    #[test]
    fn re_registering_keeps_a_tools_position() {
        // `install_permission_gate` re-registers wrapped executors in place.
        // If that moved them to the end, every launch with the gate enabled
        // would ship a differently-ordered tool list.
        let reg = registry_of(&["file_read", "grep", "shell_execute"]);
        reg.register(Arc::new(NamedTool("grep")));
        assert_eq!(reg.names(), ["file_read", "grep", "shell_execute"]);
    }

    #[test]
    fn unknown_tool_error_offers_the_nearest_name_and_the_roster() {
        let reg = registry_of(&["file_read", "grep", "shell_execute"]);
        let message = reg.unknown_tool_error("file_reed").to_string();

        assert!(message.starts_with("tool not found: file_reed"));
        assert!(
            message.contains("Did you mean `file_read`?"),
            "near-miss must be named: {message}"
        );
        assert!(
            message.contains("file_read, grep, shell_execute"),
            "roster must be listed: {message}"
        );
    }

    #[test]
    fn unknown_tool_error_lists_the_roster_even_without_a_suggestion() {
        // A tool from another harness has no Aurora analogue — the roster is
        // the whole recovery path, so it must still be there.
        let reg = registry_of(&["file_read", "grep"]);
        let message = reg.unknown_tool_error("str_replace_editor").to_string();

        assert!(!message.contains("Did you mean"));
        assert!(message.contains("Available tools: file_read, grep."));
    }

    #[test]
    fn unknown_tool_error_summarizes_an_oversized_roster() {
        let reg = ToolRegistry::new();
        for i in 0..(MAX_LISTED_TOOLS + 5) {
            // Leaked names keep the executor's `&'static str` contract; this
            // is a test-only roster and the process exits with it.
            let name: &'static str = Box::leak(format!("mcp_server_tool_{i}").into_boxed_str());
            reg.register(Arc::new(NamedTool(name)));
        }
        let message = reg.unknown_tool_error("mcp_server_tool_999999").to_string();

        assert!(message.contains(&format!("{} tools are registered", MAX_LISTED_TOOLS + 5)));
        assert!(message.contains("those starting `mcp`"));
    }

    #[test]
    fn execute_with_permission_reports_unknown_tools_helpfully() {
        let reg = registry_of(&["file_read"]);
        let result = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(reg.execute_with_permission("file_reed", serde_json::json!({}), &ctx()));

        match result {
            Err(ToolError::NotFound(message)) => {
                assert!(message.contains("Did you mean `file_read`?"), "{message}");
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn registry_clone_shares_state() {
        let a = ToolRegistry::new();
        let b = a.clone();
        a.register(Arc::new(EchoTool));
        assert_eq!(b.len(), 1, "registry must share state across clones");
    }

    #[test]
    fn tool_error_display_renders_meaningful_messages() {
        assert_eq!(
            ToolError::NotFound("foo".into()).to_string(),
            "tool not found: foo"
        );
        assert_eq!(
            ToolError::InvalidInput("missing field".into()).to_string(),
            "invalid input: missing field"
        );
        assert_eq!(
            ToolError::PathEscape("/../etc/passwd".into()).to_string(),
            "path is outside the workspace: /../etc/passwd"
        );
        assert_eq!(
            ToolError::PolicyViolation("blocked by allow-list".into()).to_string(),
            "policy violation: blocked by allow-list"
        );
        assert_eq!(ToolError::Cancelled.to_string(), "tool was cancelled");
        assert_eq!(
            ToolError::Timeout {
                timeout_ms: 5_000,
                message: "`grep` was still running after 5000ms.".into(),
            }
            .to_string(),
            "`grep` was still running after 5000ms."
        );
    }

    #[test]
    fn tool_error_is_clone_send_sync() {
        fn assert_bounds<T: Clone + Send + Sync + 'static>() {}
        assert_bounds::<ToolError>();
    }
}
