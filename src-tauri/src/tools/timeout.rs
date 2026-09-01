//! One timeout mechanism, shared by every tool that can wait.
//!
//! `shell_execute` and `grep` already had this, written twice, identically:
//! read `timeout` (falling back to `timeout_ms`), clamp it between a floor and
//! a ceiling, default it when absent, and tell the model in the schema what the
//! numbers are. That shape is the contract the model has already learned, so
//! this module is that same shape lifted into one place rather than a new one
//! invented beside it.
//!
//! Two halves:
//!
//! * [`TimeoutPolicy`] — how a timeout is *passed*: the argument names, the
//!   clamp, the default, the schema fragment, and the sentence the model reads
//!   when the clock runs out.
//! * [`TimeoutGuardedExecutor`] — how a timeout is *enforced*: a wrapper that
//!   races the tool against its own resolved budget.
//!
//! ## Why enforcement is a wrapper and not a line in the dispatch loop
//!
//! `install_permission_gate` wraps a tool that needs approval, and that gate
//! parks on the user. A timeout applied at the dispatch site would therefore be
//! counting the seconds a person spends reading an approval prompt, and a shell
//! command approved after three minutes of thought would be killed for taking
//! three minutes. So the guard goes **inside** the permission gate:
//! `permission(timeout(tool))`. `install_timeout_guards` runs before
//! `install_permission_gate` in `lib.rs::setup` for exactly that reason, and
//! swapping the two lines would silently reintroduce the bug.
//!
//! ## What this cannot do
//!
//! `tokio::time::timeout` can only interrupt a future at an await point. A tool
//! whose body is synchronous and CPU-bound (the `code` tool's tree-sitter build
//! is the live example) never yields, so the timer cannot fire until it is
//! already finished. Bounding those needs `spawn_blocking`, which is a
//! different change; they deliberately declare no policy rather than declaring
//! one that would not hold.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

/// The argument name the model writes.
pub const TIMEOUT_KEY: &str = "timeout";
/// Accepted second spelling.
///
/// Not a deprecation: `shell_execute` and `grep` have read both since they were
/// written, threads on disk carry both, and models emit both. Dropping either
/// would break replay of conversations that already happened.
pub const LEGACY_TIMEOUT_KEY: &str = "timeout_ms";

/// How long one tool may take, and what to tell the model about it.
///
/// `const`-constructible so a tool can declare its policy as an associated
/// constant next to its other limits, the way `shell_execute` declares
/// `DEFAULT_TIMEOUT_MS` / `MIN_TIMEOUT_MS` / `MAX_TIMEOUT_MS` today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeoutPolicy {
    /// Used when the caller passes nothing.
    pub default_ms: u64,
    /// Floor. A one-millisecond timeout is never what anyone meant.
    pub min_ms: u64,
    /// Ceiling. Bounds a runaway call even when the model asks for forever.
    pub max_ms: u64,
    /// One clause naming what the reader should do next. It goes in the schema
    /// and again in the timeout message, because those are read at two
    /// different moments: once when choosing the argument, once after being
    /// cut off.
    pub advice: &'static str,
}

impl TimeoutPolicy {
    #[must_use]
    pub const fn new(default_ms: u64, min_ms: u64, max_ms: u64, advice: &'static str) -> Self {
        Self {
            default_ms,
            min_ms,
            max_ms,
            advice,
        }
    }

    /// The budget for one call, in milliseconds.
    ///
    /// Key order is `timeout` then `timeout_ms`, matching `shell_execute` and
    /// `grep` exactly. A value outside the range is clamped rather than
    /// rejected: a model that asks for an hour on a browser click has made a
    /// harmless mistake, and failing the call over it costs a whole round trip
    /// to learn nothing.
    #[must_use]
    pub fn resolve(&self, input: &Value) -> u64 {
        input
            .get(TIMEOUT_KEY)
            .or_else(|| input.get(LEGACY_TIMEOUT_KEY))
            .and_then(Value::as_u64)
            .map_or(self.default_ms, |v| v.clamp(self.min_ms, self.max_ms))
    }

    #[must_use]
    pub fn duration(&self, input: &Value) -> Duration {
        Duration::from_millis(self.resolve(input))
    }

    /// The `timeout` property to splice into a tool's `input_schema`.
    ///
    /// Every tool that accepts a timeout describes it the same way, so the
    /// wording lives here. A tool that does not want to advertise the argument
    /// simply does not call this — the policy still applies, it just uses its
    /// default.
    #[must_use]
    pub fn property(&self) -> Value {
        json!({
            "type": "number",
            "description": format!(
                "Timeout in milliseconds. Defaults to {default}, minimum {min}, maximum {max}. \
                 If the timeout is hit the call is abandoned and reported as a timeout, not as a \
                 failure of the thing you asked for. {advice}",
                default = self.default_ms,
                min = self.min_ms,
                max = self.max_ms,
                advice = self.advice,
            ),
        })
    }

    /// The sentence the model reads when the clock runs out.
    ///
    /// It says three things on purpose: that the call was abandoned rather than
    /// answered, that nothing is known about whether the work finished, and
    /// what to do next. The middle one matters most — a timeout is the one
    /// result where Aurora genuinely does not know the outcome, and any wording
    /// that implies otherwise sends the model off to "fix" something that may
    /// have already worked.
    #[must_use]
    pub fn timed_out_message(&self, tool: &str, timeout_ms: u64) -> String {
        format!(
            "`{tool}` was still running after {timeout_ms}ms and was abandoned. Whether the work \
             it started finished is unknown — check before assuming it did or did not. {advice}",
            advice = self.advice,
        )
    }
}

/// Enforces one tool's [`TimeoutPolicy`].
///
/// Transparent in every other respect: name, schema, permission requirement,
/// batchability and lifecycle ownership all come from the inner tool, so
/// wrapping changes nothing a caller can observe except that the call now ends.
pub struct TimeoutGuardedExecutor {
    inner: Arc<dyn ToolExecutor>,
    policy: TimeoutPolicy,
}

impl TimeoutGuardedExecutor {
    #[must_use]
    pub fn new(inner: Arc<dyn ToolExecutor>, policy: TimeoutPolicy) -> Self {
        Self { inner, policy }
    }

    /// Wrap only if the tool asked for it.
    ///
    /// Returns the tool untouched when it declares no policy, so a registry
    /// pass over every tool is a no-op for the ones that bound themselves
    /// internally (`shell_execute` kills its own process and keeps the partial
    /// output, which is strictly better than being abandoned from outside).
    #[must_use]
    pub fn maybe_wrap(inner: Arc<dyn ToolExecutor>) -> Arc<dyn ToolExecutor> {
        match inner.timeout_policy() {
            Some(policy) => Arc::new(Self::new(inner, policy)),
            None => inner,
        }
    }
}

impl std::fmt::Debug for TimeoutGuardedExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimeoutGuardedExecutor")
            .field("name", &self.inner.name())
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ToolExecutor for TimeoutGuardedExecutor {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> ToolSchema {
        self.inner.schema()
    }

    fn requires_permission(&self) -> bool {
        self.inner.requires_permission()
    }

    fn concurrency_safe(&self) -> bool {
        self.inner.concurrency_safe()
    }

    fn uses_frontend_lifecycle(&self) -> bool {
        self.inner.uses_frontend_lifecycle()
    }

    /// Already enforced here.
    ///
    /// Mirrors `PermissionGuardedExecutor::requires_permission`, and for the
    /// same reason: a second pass over the registry, or a wrapper that wraps a
    /// wrapper, must not stack two clocks on one call.
    fn timeout_policy(&self) -> Option<TimeoutPolicy> {
        None
    }

    async fn execute(&self, input: Value, context: &ToolContext) -> Result<String, ToolError> {
        // Read the budget before `input` is moved into the inner call.
        let timeout_ms = self.policy.resolve(&input);
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.inner.execute(input, context),
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => Err(ToolError::Timeout {
                timeout_ms,
                message: self.policy.timed_out_message(self.inner.name(), timeout_ms),
            }),
        }
    }
}

/// Wrap every tool in `reg` that declares a [`TimeoutPolicy`], in place.
///
/// Mirrors `install_permission_gate` — same registry-walk shape, same
/// re-register-under-the-same-name trick (`ToolRegistry::register` keeps a
/// tool's original ordering slot, so the roster the model sees does not
/// reshuffle).
///
/// **Call this before `install_permission_gate`.** See the module docs: the
/// approval wait must sit outside the clock.
pub fn install_timeout_guards(reg: &ToolRegistry) {
    let mut wrapped: Vec<String> = Vec::new();
    for name in reg.names() {
        if let Some(executor) = reg.get(&name) {
            if executor.timeout_policy().is_some() {
                reg.register(TimeoutGuardedExecutor::maybe_wrap(executor));
                wrapped.push(name);
            }
        }
    }
    eprintln!(
        "[install_timeout_guards] bounded {} tool(s): {:?}",
        wrapped.len(),
        wrapped
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    const TEST_POLICY: TimeoutPolicy =
        TimeoutPolicy::new(30_000, 1_000, 300_000, "Pass a larger `timeout`.");

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "th".into(),
            workspace_root: None,
            workspace_access: Default::default(),
            spill_dir: None,
            cancel_token: CancellationToken::new(),
        }
    }

    struct Sleeper {
        millis: u64,
    }

    #[async_trait]
    impl ToolExecutor for Sleeper {
        fn name(&self) -> &str {
            "sleeper"
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: "sleeper".into(),
                description: String::new(),
                input_schema: json!({"type": "object"}),
            }
        }
        fn timeout_policy(&self) -> Option<TimeoutPolicy> {
            Some(TEST_POLICY)
        }
        async fn execute(&self, _input: Value, _ctx: &ToolContext) -> Result<String, ToolError> {
            tokio::time::sleep(Duration::from_millis(self.millis)).await;
            Ok("finished".into())
        }
    }

    /// The whole point: `timeout` then `timeout_ms`, clamped, defaulted. This
    /// is the shape `shell_execute` and `grep` established; if it drifts, a
    /// model that learned one tool's timeout argument has to relearn it on the
    /// next.
    #[test]
    fn the_argument_is_read_the_same_way_shell_execute_reads_it() {
        assert_eq!(TEST_POLICY.resolve(&json!({})), 30_000);
        assert_eq!(TEST_POLICY.resolve(&json!({"timeout": 5_000})), 5_000);
        assert_eq!(TEST_POLICY.resolve(&json!({"timeout_ms": 5_000})), 5_000);
        // `timeout` wins when both arrive.
        assert_eq!(
            TEST_POLICY.resolve(&json!({"timeout": 5_000, "timeout_ms": 9_000})),
            5_000
        );
        // Out-of-range is clamped, never rejected.
        assert_eq!(TEST_POLICY.resolve(&json!({"timeout": 1})), 1_000);
        assert_eq!(
            TEST_POLICY.resolve(&json!({"timeout": 99_999_999})),
            300_000
        );
        // A non-number is not a timeout. Fall back rather than guess.
        assert_eq!(TEST_POLICY.resolve(&json!({"timeout": "30s"})), 30_000);
    }

    #[tokio::test]
    async fn a_tool_that_finishes_in_time_is_untouched() {
        let guarded = TimeoutGuardedExecutor::maybe_wrap(Arc::new(Sleeper { millis: 1 }));
        let out = guarded
            .execute(json!({"timeout": 1_000}), &ctx())
            .await
            .expect("ok");
        assert_eq!(out, "finished");
    }

    #[tokio::test]
    async fn a_tool_that_overruns_is_abandoned_and_says_so() {
        let guarded = TimeoutGuardedExecutor::maybe_wrap(Arc::new(Sleeper { millis: 60_000 }));
        let err = guarded
            .execute(json!({"timeout": 1_000}), &ctx())
            .await
            .expect_err("timed out");
        match &err {
            ToolError::Timeout {
                timeout_ms,
                message,
            } => {
                assert_eq!(*timeout_ms, 1_000);
                // The message must NOT claim the work failed — that is the one
                // thing a timeout cannot know.
                assert!(message.contains("unknown"), "{message}");
                assert!(message.contains("sleeper"), "{message}");
                assert!(message.contains("Pass a larger `timeout`"), "{message}");
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
    }

    /// Double-wrapping must not stack two clocks. A registry pass that runs
    /// twice — or a wrapper wrapping a wrapper — has to be a no-op.
    #[test]
    fn a_guarded_tool_declares_no_further_policy() {
        let guarded = TimeoutGuardedExecutor::maybe_wrap(Arc::new(Sleeper { millis: 1 }));
        assert!(guarded.timeout_policy().is_none());
        let twice = TimeoutGuardedExecutor::maybe_wrap(guarded);
        assert!(twice.timeout_policy().is_none());
    }

    #[test]
    fn a_tool_with_no_policy_is_returned_unwrapped() {
        struct Bare;
        #[async_trait]
        impl ToolExecutor for Bare {
            fn name(&self) -> &str {
                "bare"
            }
            fn schema(&self) -> ToolSchema {
                ToolSchema {
                    name: "bare".into(),
                    description: String::new(),
                    input_schema: json!({"type": "object"}),
                }
            }
            async fn execute(
                &self,
                _input: Value,
                _ctx: &ToolContext,
            ) -> Result<String, ToolError> {
                Ok("bare".into())
            }
        }
        let inner: Arc<dyn ToolExecutor> = Arc::new(Bare);
        let out = TimeoutGuardedExecutor::maybe_wrap(inner.clone());
        assert!(Arc::ptr_eq(&inner, &out), "an unbounded tool was wrapped");
    }

    #[test]
    fn the_schema_property_states_all_three_numbers() {
        let property = TEST_POLICY.property();
        let description = property["description"].as_str().expect("description");
        assert!(description.contains("30000"), "{description}");
        assert!(description.contains("1000"), "{description}");
        assert!(description.contains("300000"), "{description}");
        assert!(
            description.contains("Pass a larger `timeout`"),
            "{description}"
        );
    }
}
