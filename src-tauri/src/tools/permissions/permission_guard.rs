//! Permission-guarded executor decorator.
//!
//! Wraps any [`ToolExecutor`] whose [`ToolExecutor::requires_permission`]
//! returns `true` so the runtime's existing dispatch path
//! (`tool.execute(...)` in [`crate::agent_runtime::conversation::ConversationRuntime::run_turn`])
//! transparently consults the [`Permitter`] before running the inner
//! tool — no changes to the conversation loop required.
//!
//! Sub-D shipped a separate [`crate::agent_runtime::tool_executor::ToolRegistry::execute_with_permission`]
//! method that fires the gate on its own. The legacy gate-free path is
//! still used by `ConversationRuntime`, so this decorator bridges the
//! two: from the runtime's perspective it's just another tool, from
//! the gate's perspective it owns the prompter call.
//!
//! Layering:
//!
//! ```text
//! ConversationRuntime::run_turn
//!  └── ToolRegistry::get(name).execute(...)   ← unchanged dispatch
//!       └── PermissionGuardedExecutor::execute (this struct)
//!            ├── Permitter::request(turn_id, name, input, cancel)
//!            ├── if !granted → ToolError::PermissionDenied
//!            └── else → inner.execute(input, ctx)
//! ```

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{Permitter, ToolContext, ToolError, ToolExecutor};

/// Decorator that gates an inner [`ToolExecutor`] on a [`Permitter`]
/// verdict.
///
/// The decorator's own `requires_permission()` returns `false` so
/// downstream callers (notably [`crate::agent_runtime::tool_executor::ToolRegistry::execute_with_permission`])
/// don't double-prompt. The gate fires inside `execute(..)`.
pub struct PermissionGuardedExecutor {
    inner: Arc<dyn ToolExecutor>,
    permitter: Arc<dyn Permitter>,
}

impl PermissionGuardedExecutor {
    /// Wrap `inner` so it consults `permitter` before executing.
    #[must_use]
    pub fn new(inner: Arc<dyn ToolExecutor>, permitter: Arc<dyn Permitter>) -> Self {
        Self { inner, permitter }
    }

    /// If `inner.requires_permission()` is `true`, return a wrapped
    /// `Arc<dyn ToolExecutor>` that consults `permitter`. Otherwise
    /// return `inner` unchanged so non-gated tools don't pay the
    /// indirection cost.
    #[must_use]
    pub fn maybe_wrap(
        inner: Arc<dyn ToolExecutor>,
        permitter: &Arc<dyn Permitter>,
    ) -> Arc<dyn ToolExecutor> {
        if inner.requires_permission() {
            Arc::new(Self::new(inner, permitter.clone()))
        } else {
            inner
        }
    }
}

#[async_trait]
impl ToolExecutor for PermissionGuardedExecutor {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> ToolSchema {
        self.inner.schema()
    }

    fn requires_permission(&self) -> bool {
        // Already gated by us — don't double-prompt if some caller
        // happens to use `execute_with_permission` instead of the
        // legacy path.
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        // Cheap pre-check: don't wake the permitter if cancel already
        // fired. Mirrors the `FrontendBridgeExecutor` short-circuit.
        ctx.bail_if_cancelled()?;

        eprintln!(
            "[PermissionGuardedExecutor] consulting permitter for tool={} turn={} tool_use_id={}",
            self.inner.name(),
            ctx.turn_id,
            ctx.tool_call_id
        );
        let granted = self
            .permitter
            .request(
                &ctx.turn_id,
                &ctx.tool_call_id,
                self.inner.name(),
                &input,
                ctx.cancel_token.clone(),
            )
            .await?;
        eprintln!(
            "[PermissionGuardedExecutor] permitter resolved tool={} granted={granted}",
            self.inner.name()
        );

        if !granted {
            return Err(ToolError::PermissionDenied(format!(
                "user denied {}",
                self.inner.name()
            )));
        }

        self.inner.execute(input, ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::permissions::prompter::MockPermitter;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio_util::sync::CancellationToken;

    struct CountingTool {
        permission_required: bool,
        call_count: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ToolExecutor for CountingTool {
        fn name(&self) -> &str {
            "shell_execute"
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: "shell_execute".to_string(),
                description: "test".to_string(),
                input_schema: serde_json::json!({}),
            }
        }
        fn requires_permission(&self) -> bool {
            self.permission_required
        }
        async fn execute(&self, _input: Value, _ctx: &ToolContext) -> Result<String, ToolError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            Ok("ran".to_string())
        }
    }

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "t-1".into(),
            tool_call_id: "call-1".into(),
            session_id: "sess".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn maybe_wrap_returns_inner_when_permission_not_required() {
        let inner: Arc<dyn ToolExecutor> = Arc::new(CountingTool {
            permission_required: false,
            call_count: Arc::new(AtomicUsize::new(0)),
        });
        let permitter: Arc<dyn Permitter> = Arc::new(MockPermitter::denying());
        let wrapped = PermissionGuardedExecutor::maybe_wrap(inner.clone(), &permitter);
        // Same Arc — no decoration overhead for non-gated tools.
        assert!(Arc::ptr_eq(&inner, &wrapped));
    }

    #[tokio::test]
    async fn maybe_wrap_decorates_when_permission_required() {
        let counter = Arc::new(AtomicUsize::new(0));
        let inner: Arc<dyn ToolExecutor> = Arc::new(CountingTool {
            permission_required: true,
            call_count: counter.clone(),
        });
        let permitter: Arc<dyn Permitter> = Arc::new(MockPermitter::granting());
        let wrapped = PermissionGuardedExecutor::maybe_wrap(inner.clone(), &permitter);
        // Different Arc — decorated.
        assert!(!Arc::ptr_eq(&inner, &wrapped));
        // The decorator masks `requires_permission()` so callers don't
        // double-prompt.
        assert!(!wrapped.requires_permission());
        // Granted → inner ran.
        let out = wrapped.execute(serde_json::json!({}), &ctx()).await.unwrap();
        assert_eq!(out, "ran");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn denied_returns_permission_denied_and_skips_inner() {
        let counter = Arc::new(AtomicUsize::new(0));
        let inner: Arc<dyn ToolExecutor> = Arc::new(CountingTool {
            permission_required: true,
            call_count: counter.clone(),
        });
        let permitter: Arc<dyn Permitter> = Arc::new(MockPermitter::denying());
        let guard = PermissionGuardedExecutor::new(inner, permitter);
        let err = guard
            .execute(serde_json::json!({}), &ctx())
            .await
            .expect_err("must deny");
        assert!(matches!(err, ToolError::PermissionDenied(_)));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pre_cancel_short_circuits_before_permitter() {
        let inner: Arc<dyn ToolExecutor> = Arc::new(CountingTool {
            permission_required: true,
            call_count: Arc::new(AtomicUsize::new(0)),
        });
        let permitter = Arc::new(MockPermitter::granting());
        let permitter_dyn: Arc<dyn Permitter> = permitter.clone();
        let guard = PermissionGuardedExecutor::new(inner, permitter_dyn);

        let mut c = ctx();
        c.cancel_token.cancel();
        let err = guard
            .execute(serde_json::json!({}), &c)
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        // Permitter never consulted because cancel fired first.
        assert_eq!(permitter.call_count(), 0);
    }
}
