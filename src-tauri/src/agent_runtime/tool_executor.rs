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

/// Per-execution context handed to a tool's `execute` call.
///
/// Carries enough identity for logging/tracing (`turn_id`,
/// `tool_call_id`, `session_id`), the workspace root every file-touching
/// tool resolves paths against, and the cancel token tied to the
/// surrounding turn.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub turn_id: String,
    pub tool_call_id: String,
    pub session_id: String,
    pub workspace_root: Option<PathBuf>,
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

    #[error("tool timed out after {0}ms")]
    Timeout(u64),
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
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: Arc<DashMap<String, Arc<dyn ToolExecutor>>>,
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
    /// previous entry — useful for hot-reload but should be rare.
    pub fn register(&self, executor: Arc<dyn ToolExecutor>) {
        let name = executor.name().to_string();
        self.tools.insert(name, executor);
    }

    /// Look up a tool by name. Returns `None` if not registered.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Arc<dyn ToolExecutor>> {
        self.tools.get(name).map(|e| e.value().clone())
    }

    /// Snapshot every registered tool's schema. The returned `Vec` is
    /// what the runtime hands to [`super::api_client::ApiRequest::tools`].
    #[must_use]
    pub fn schemas(&self) -> Vec<ToolSchema> {
        self.tools.iter().map(|e| e.value().schema()).collect()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Names of every registered tool, in non-deterministic order.
    /// Useful for diagnostics and the audit log.
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.tools.iter().map(|e| e.key().clone()).collect()
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
            .ok_or_else(|| ToolError::NotFound(name.to_string()))?;

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
            session_id: "s-1".into(),
            workspace_root: None,
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
            ToolError::Timeout(5_000).to_string(),
            "tool timed out after 5000ms"
        );
    }

    #[test]
    fn tool_error_is_clone_send_sync() {
        fn assert_bounds<T: Clone + Send + Sync + 'static>() {}
        assert_bounds::<ToolError>();
    }
}
