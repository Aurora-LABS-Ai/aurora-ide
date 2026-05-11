//! Phase 4 hook system.
//!
//! Hooks are user-extensible callbacks that fire **around** every
//! tool dispatch in [`super::conversation::ConversationRuntime::run_turn`].
//! They give Aurora (and downstream embedders) a place to plug in
//! audit logging, metrics, custom guardrails, automatic checkpoints,
//! or even MCP-style "post-tool-use" automation without having to
//! modify the runtime itself.
//!
//! The shape mirrors `claw-code/rust/crates/runtime/src/hooks.rs` and
//! Anthropic's CC hook surface:
//!
//! - [`Hook::pre_tool_use`] fires **before** the runtime calls
//!   `ToolExecutor::execute`. The hook receives the tool name and
//!   the raw `serde_json::Value` input the model emitted.
//! - [`Hook::post_tool_use`] fires **after** the runtime gets a
//!   result back, **regardless of success or failure**. The hook
//!   receives the same name plus a [`ToolHookResult`] borrow that
//!   carries either the success string or the [`super::tool_executor::ToolError`].
//!
//! Both methods default to no-ops so implementors can opt into
//! exactly the lifecycle stage they care about.
//!
//! ## Composition
//!
//! [`HookChain`] wraps a `Vec<Arc<dyn Hook>>` and itself implements
//! [`Hook`] by walking the inner list sequentially. This is the
//! canonical way to install multiple hooks at once — the runtime
//! itself only ever holds a single `Arc<dyn Hook>`, but that hook may
//! be a chain.
//!
//! ## Additive wiring
//!
//! [`super::conversation::ConversationRuntime`] holds an optional
//! [`Arc<dyn Hook>`] that defaults to [`NoopHook`]. Existing
//! `ConversationRuntime::new(api, tools, config)` callers see no
//! behaviour change. New callers opt in via
//! [`super::conversation::ConversationRuntime::with_hook`].

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;

use super::tool_executor::ToolError;

/// Outcome of a single tool call, borrowed for the lifetime of the
/// post-tool-use hook callback.
///
/// Mirrors the way the conversation runtime represents tool outcomes
/// internally — `Result<String, ToolError>` — but in a borrow-friendly
/// shape that doesn't require cloning the success payload (which can
/// be megabytes for `multi_file_read`) just to hand it to a hook.
#[derive(Debug, Clone, Copy)]
pub enum ToolHookResult<'a> {
    /// Tool returned `Ok(content)`. The reference points at the
    /// runtime's owned success string.
    Success(&'a str),
    /// Tool returned `Err(error)`. The reference points at the
    /// runtime's owned error. Use [`ToolError::to_string`] inside the
    /// hook if a `String` is needed.
    Error(&'a ToolError),
}

impl<'a> ToolHookResult<'a> {
    /// `true` when the underlying outcome is `Ok(_)`.
    #[must_use]
    pub fn is_success(&self) -> bool {
        matches!(self, ToolHookResult::Success(_))
    }

    /// `true` when the underlying outcome is `Err(_)`.
    #[must_use]
    pub fn is_error(&self) -> bool {
        matches!(self, ToolHookResult::Error(_))
    }
}

/// Lifecycle hook for tool dispatch.
///
/// All implementors must be `Send + Sync + 'static` because the
/// runtime stores the hook as `Arc<dyn Hook>` and clones the `Arc`
/// across `tokio::spawn` boundaries inside `run_turn`. The default
/// methods are intentional no-ops so that adding a new method to
/// the trait in a later phase doesn't break existing implementors —
/// follow the same pattern when extending.
#[async_trait]
pub trait Hook: Send + Sync + 'static {
    /// Fires immediately **before** the runtime invokes the tool's
    /// `execute` method. The default is a no-op.
    ///
    /// `input` is the raw JSON the model emitted, untouched by the
    /// runtime. Hooks must NOT mutate it (it's borrowed `&Value`) —
    /// rewriting tool inputs is a Phase 4+ feature behind a separate
    /// trait.
    async fn pre_tool_use(&self, _name: &str, _input: &serde_json::Value) {}

    /// Fires immediately **after** the tool's `execute` method
    /// returns, regardless of success or failure. The default is a
    /// no-op.
    ///
    /// `result` borrows the success payload (a `&str`) or the
    /// resulting [`ToolError`] for the duration of the hook call.
    async fn post_tool_use(&self, _name: &str, _result: ToolHookResult<'_>) {}
}

/// No-op hook, used as the default when a runtime is built without
/// an explicit hook. Both methods inherit the trait defaults.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopHook;

#[async_trait]
impl Hook for NoopHook {}

/// Sequential composition of multiple hooks.
///
/// Implements [`Hook`] by walking the inner `Vec` in order on each
/// callback. Errors and panics from one hook do **not** stop the
/// chain — that's by design: a chain is a fan-out, not a pipeline.
/// (We catch panics through the underlying `tokio::spawn` runtime,
/// not at the chain level — hooks are expected to be infallible
/// telemetry sinks.)
pub struct HookChain {
    hooks: Vec<Arc<dyn Hook>>,
}

impl std::fmt::Debug for HookChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookChain")
            .field("hook_count", &self.hooks.len())
            .finish()
    }
}

impl HookChain {
    #[must_use]
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    #[must_use]
    pub fn from_vec(hooks: Vec<Arc<dyn Hook>>) -> Self {
        Self { hooks }
    }

    pub fn push(&mut self, hook: Arc<dyn Hook>) {
        self.hooks.push(hook);
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.hooks.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

impl Default for HookChain {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Hook for HookChain {
    async fn pre_tool_use(&self, name: &str, input: &serde_json::Value) {
        for hook in &self.hooks {
            hook.pre_tool_use(name, input).await;
        }
    }

    async fn post_tool_use(&self, name: &str, result: ToolHookResult<'_>) {
        for hook in &self.hooks {
            hook.post_tool_use(name, result).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Test recorder that captures every callback in order. Threading
    /// is straightforward: hooks fire sequentially per turn so a
    /// single Mutex<Vec<_>> is sufficient.
    #[derive(Default)]
    struct RecordingHook {
        events: Mutex<Vec<String>>,
    }

    impl RecordingHook {
        fn snapshot(&self) -> Vec<String> {
            self.events.lock().expect("events").clone()
        }
    }

    #[async_trait]
    impl Hook for RecordingHook {
        async fn pre_tool_use(&self, name: &str, input: &serde_json::Value) {
            self.events
                .lock()
                .expect("events")
                .push(format!("pre:{name}:{input}"));
        }

        async fn post_tool_use(&self, name: &str, result: ToolHookResult<'_>) {
            let tag = match result {
                ToolHookResult::Success(s) => format!("ok:{s}"),
                ToolHookResult::Error(e) => format!("err:{e}"),
            };
            self.events
                .lock()
                .expect("events")
                .push(format!("post:{name}:{tag}"));
        }
    }

    #[tokio::test]
    async fn noop_hook_callbacks_are_silent() {
        let hook = NoopHook;
        // Must compile and complete without observable side-effects.
        hook.pre_tool_use("tool_a", &serde_json::json!({})).await;
        hook.post_tool_use("tool_a", ToolHookResult::Success("done"))
            .await;
        hook.post_tool_use(
            "tool_a",
            ToolHookResult::Error(&ToolError::Execution("nope".into())),
        )
        .await;
    }

    #[tokio::test]
    async fn recording_hook_captures_pre_and_post_for_success() {
        let hook = RecordingHook::default();
        hook.pre_tool_use("file_read", &serde_json::json!({"path":"a.txt"}))
            .await;
        hook.post_tool_use("file_read", ToolHookResult::Success("contents"))
            .await;

        let events = hook.snapshot();
        assert_eq!(events.len(), 2);
        assert!(events[0].starts_with("pre:file_read"));
        assert!(events[1].starts_with("post:file_read:ok:contents"));
    }

    #[tokio::test]
    async fn recording_hook_captures_post_on_error() {
        let hook = RecordingHook::default();
        let err = ToolError::Execution("boom".into());
        hook.post_tool_use("file_read", ToolHookResult::Error(&err))
            .await;
        let events = hook.snapshot();
        assert_eq!(events.len(), 1);
        assert!(
            events[0].contains("err:execution failed: boom"),
            "got: {}",
            events[0]
        );
    }

    #[tokio::test]
    async fn hook_chain_runs_hooks_in_order() {
        let a = Arc::new(RecordingHook::default());
        let b = Arc::new(RecordingHook::default());
        let chain = HookChain::from_vec(vec![a.clone(), b.clone()]);
        assert_eq!(chain.len(), 2);

        chain
            .pre_tool_use("grep", &serde_json::json!({"q":"x"}))
            .await;
        chain
            .post_tool_use("grep", ToolHookResult::Success("3 hits"))
            .await;

        // Both hooks must have observed both events.
        assert_eq!(a.snapshot().len(), 2);
        assert_eq!(b.snapshot().len(), 2);
        assert!(a.snapshot()[0].starts_with("pre:grep"));
        assert!(b.snapshot()[1].starts_with("post:grep:ok:3 hits"));
    }

    #[tokio::test]
    async fn empty_hook_chain_is_silent() {
        let chain = HookChain::new();
        assert!(chain.is_empty());
        chain
            .pre_tool_use("any", &serde_json::json!({}))
            .await;
        chain
            .post_tool_use("any", ToolHookResult::Success(""))
            .await;
    }

    #[tokio::test]
    async fn hook_chain_can_grow_via_push() {
        let h = Arc::new(RecordingHook::default());
        let mut chain = HookChain::new();
        chain.push(h.clone());
        chain
            .pre_tool_use("shell", &serde_json::json!({}))
            .await;
        assert_eq!(h.snapshot().len(), 1);
    }

    #[test]
    fn tool_hook_result_helpers() {
        let s = ToolHookResult::Success("ok");
        assert!(s.is_success());
        assert!(!s.is_error());
        let err = ToolError::Cancelled;
        let e = ToolHookResult::Error(&err);
        assert!(e.is_error());
        assert!(!e.is_success());
    }

    #[tokio::test]
    async fn arc_dyn_hook_dispatches_through_trait_object() {
        // Ensures `Arc<dyn Hook>` is a usable shape for the runtime.
        let h: Arc<dyn Hook> = Arc::new(RecordingHook::default());
        h.pre_tool_use("noop", &serde_json::json!({})).await;
        h.post_tool_use("noop", ToolHookResult::Success("")).await;
    }
}
