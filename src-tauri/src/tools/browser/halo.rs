//! The halo — telling the user when the agent is driving the Browser panel.
//!
//! The panel's page is a native webview that paints ABOVE Aurora's React DOM.
//! That has a consequence worth stating plainly: when the agent clicks
//! something, scrolls, or swaps the URL, the page changes under the user with
//! nothing on screen saying who did it. It looks exactly like the page acting
//! on its own. Every other agent action in Aurora lands in the transcript where
//! it is attributed; this one lands in a live surface the user may be watching
//! directly.
//!
//! So the panel shows a cue while a browser tool runs — and only while one
//! runs. A permanent "the agent can drive this" badge would be true all session
//! and therefore say nothing; the whole value is in the difference between
//! moving and not moving.
//!
//! ## Why a wrapper and not sixteen call sites
//!
//! The alternative was an emit at the top and bottom of every `execute`. There
//! are sixteen of them across five files, they return early on bad input, and
//! the next tool added would simply forget. A wrapper cannot forget: it is
//! applied once, in [`super::register`], to whatever is in the roster.
//!
//! ## Why a drop guard
//!
//! The "off" signal is sent from [`Drop`], not from the end of `execute`. A
//! tool can leave three other ways — an `Err` return, a cancelled turn (the
//! future is dropped mid-await), or a panic — and any of them skipping the
//! `false` would leave the panel claiming the agent is still driving for the
//! rest of the session. A cue that can get stuck on is worse than no cue: it
//! trains the user to ignore it.
//!
//! `browser_guidelines` is deliberately NOT wrapped. It returns compiled-in
//! text and never touches the panel, so a halo on it would be a lie in the
//! cheap direction — the indicator flashing while nothing happens.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

/// Where the "agent is driving" cue is raised and lowered.
///
/// A seam, not indirection for its own sake: [`BrowserManager`] needs a live
/// Tauri `AppHandle`, so without this the wrapper's pass-through contract —
/// which includes the permission gate — could not be tested at all. A silently
/// dropped `requires_permission` would let every gated browser tool run without
/// asking, which is exactly the class of bug that must not depend on someone
/// noticing it in review.
pub trait PanelSignal: Send + Sync {
    fn set_driving(&self, tool: &str, active: bool);
}

impl PanelSignal for BrowserManager {
    fn set_driving(&self, tool: &str, active: bool) {
        self.signal_panel_activity(tool, active);
    }
}

/// Holds the panel's cue on for as long as it is alive.
///
/// Constructed before the wrapped tool runs and dropped however the tool
/// leaves — return, error, cancellation, or unwind.
struct DrivingGuard {
    signal: Arc<dyn PanelSignal>,
    tool: &'static str,
}

impl DrivingGuard {
    fn new(signal: Arc<dyn PanelSignal>, tool: &'static str) -> Self {
        signal.set_driving(tool, true);
        Self { signal, tool }
    }
}

impl Drop for DrivingGuard {
    fn drop(&mut self) {
        self.signal.set_driving(self.tool, false);
    }
}

/// A browser tool with the panel cue wired around it.
///
/// Every other part of the executor contract is passed straight through —
/// name, schema, permission gate, concurrency, lifecycle ownership. This type
/// decides nothing about the tool it wraps; wrapping must be invisible to the
/// registry, the permission gate, and the model.
pub struct Driven {
    inner: Arc<dyn ToolExecutor>,
    signal: Arc<dyn PanelSignal>,
    /// The wrapped tool's name, borrowed for the lifetime of the process.
    ///
    /// [`ToolExecutor::name`] returns a `&str` tied to `&self`, and the guard
    /// outlives that borrow inside the async body. Every browser tool's name is
    /// a string literal, so leaking one string per tool at registration is a
    /// bounded, one-time cost — sixteen names for the life of the process —
    /// and it keeps the guard allocation-free on the hot path.
    name: &'static str,
}

impl Driven {
    pub fn wrap(
        inner: Arc<dyn ToolExecutor>,
        signal: Arc<dyn PanelSignal>,
    ) -> Arc<dyn ToolExecutor> {
        let name: &'static str = Box::leak(inner.name().to_string().into_boxed_str());
        Arc::new(Self {
            inner,
            signal,
            name,
        })
    }
}

#[async_trait]
impl ToolExecutor for Driven {
    fn name(&self) -> &str {
        self.name
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

    /// The bound for every panel-touching tool lives here, for the same reason
    /// the driving cue does: this wrapper is the one place all fifteen of them
    /// pass through, so a sixteenth cannot be added unbounded by accident.
    /// An inner tool that declares its own policy keeps it.
    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        self.inner.timeout_policy().or(Some(super::PANEL_TIMEOUT))
    }

    async fn execute(&self, input: Value, context: &ToolContext) -> Result<String, ToolError> {
        let _driving = DrivingGuard::new(self.signal.clone(), self.name);
        self.inner.execute(input, context).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, bool)>>);

    impl Recorder {
        fn taken(&self) -> Vec<(String, bool)> {
            self.0.lock().unwrap().clone()
        }
    }

    impl PanelSignal for Recorder {
        fn set_driving(&self, tool: &str, active: bool) {
            self.0.lock().unwrap().push((tool.to_string(), active));
        }
    }

    /// Stands in for a real browser tool: answers to a name, can be told to
    /// fail or to hang, and reports whichever contract flags the test needs.
    struct Fake {
        name: &'static str,
        fail: bool,
        hang: bool,
        permission: bool,
        concurrent: bool,
        frontend_lifecycle: bool,
    }

    impl Fake {
        fn new(name: &'static str) -> Self {
            Self {
                name,
                fail: false,
                hang: false,
                permission: false,
                concurrent: false,
                frontend_lifecycle: false,
            }
        }
    }

    #[async_trait]
    impl ToolExecutor for Fake {
        fn name(&self) -> &str {
            self.name
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: self.name.into(),
                description: "fake".into(),
                input_schema: json!({ "type": "object" }),
            }
        }
        fn requires_permission(&self) -> bool {
            self.permission
        }
        fn concurrency_safe(&self) -> bool {
            self.concurrent
        }
        fn uses_frontend_lifecycle(&self) -> bool {
            self.frontend_lifecycle
        }
        async fn execute(&self, _input: Value, _ctx: &ToolContext) -> Result<String, ToolError> {
            if self.hang {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            if self.fail {
                return Err(ToolError::Execution("boom".into()));
            }
            Ok("ok".into())
        }
    }

    fn ctx() -> ToolContext {
        ToolContext {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            thread_id: "thread-1".into(),
            workspace_root: None,
            workspace_access: Default::default(),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    #[tokio::test]
    async fn the_cue_goes_on_before_the_call_and_off_after() {
        let recorder = Arc::new(Recorder::default());
        let tool = Driven::wrap(Arc::new(Fake::new("browser_click")), recorder.clone());

        assert_eq!(tool.execute(json!({}), &ctx()).await.unwrap(), "ok");
        assert_eq!(
            recorder.taken(),
            vec![
                ("browser_click".to_string(), true),
                ("browser_click".to_string(), false),
            ]
        );
    }

    /// The failure path is the one that matters: a tool that errors is exactly
    /// when the user is most likely to be staring at the panel wondering what
    /// happened, and a cue stuck on would answer "still working".
    #[tokio::test]
    async fn a_failed_tool_still_turns_the_cue_off() {
        let recorder = Arc::new(Recorder::default());
        let mut fake = Fake::new("browser_fill");
        fake.fail = true;
        let tool = Driven::wrap(Arc::new(fake), recorder.clone());

        assert!(tool.execute(json!({}), &ctx()).await.is_err());
        assert_eq!(
            recorder.taken().last(),
            Some(&("browser_fill".into(), false))
        );
    }

    /// Cancelling a turn drops the tool's future mid-await — it never returns,
    /// so nothing written after the `.await` would ever run. Only the drop
    /// guard clears the cue here.
    #[tokio::test]
    async fn a_cancelled_tool_still_turns_the_cue_off() {
        let recorder = Arc::new(Recorder::default());
        let mut fake = Fake::new("browser_scroll");
        fake.hang = true;
        let tool = Driven::wrap(Arc::new(fake), recorder.clone());

        let cut_short =
            tokio::time::timeout(Duration::from_millis(20), tool.execute(json!({}), &ctx())).await;

        assert!(
            cut_short.is_err(),
            "the fake should have outlived the timeout"
        );
        assert_eq!(
            recorder.taken(),
            vec![
                ("browser_scroll".to_string(), true),
                ("browser_scroll".to_string(), false),
            ]
        );
    }

    /// Wrapping must be invisible to everything upstream. A dropped
    /// `requires_permission` would be the worst of these: every gated browser
    /// tool would start running without asking, and nothing else in the system
    /// would notice.
    #[tokio::test]
    async fn wrapping_passes_the_whole_executor_contract_through() {
        let recorder = Arc::new(Recorder::default());
        let mut fake = Fake::new("browser_navigate");
        fake.permission = true;
        fake.concurrent = true;
        fake.frontend_lifecycle = true;
        let tool = Driven::wrap(Arc::new(fake), recorder);

        assert_eq!(tool.name(), "browser_navigate");
        assert_eq!(tool.schema().name, "browser_navigate");
        assert!(
            tool.requires_permission(),
            "the permission gate was dropped"
        );
        assert!(tool.concurrency_safe());
        assert!(tool.uses_frontend_lifecycle());
    }

    /// The defaults have to survive too — a wrapper that hard-coded `true`
    /// would prompt on every read-only look at the page.
    #[tokio::test]
    async fn wrapping_does_not_invent_a_permission_gate() {
        let recorder = Arc::new(Recorder::default());
        let tool = Driven::wrap(Arc::new(Fake::new("browser_status")), recorder);

        assert!(!tool.requires_permission());
        assert!(!tool.concurrency_safe());
        assert!(!tool.uses_frontend_lifecycle());
    }

    /// Every tool that reaches the panel goes through this wrapper, so the
    /// bound belongs here. A browser tool added later cannot arrive unbounded
    /// without also skipping the driving cue, which is loud enough to notice.
    #[tokio::test]
    async fn every_driven_tool_is_bounded() {
        let recorder = Arc::new(Recorder::default());
        let tool = Driven::wrap(Arc::new(Fake::new("browser_click")), recorder);

        assert_eq!(tool.timeout_policy(), Some(super::super::PANEL_TIMEOUT));
    }

    /// A dead server makes every page-side read take its full 30s, and one call
    /// can chain three. The bound has to sit clear of that or a browser pointed
    /// at a stopped dev server would be cut off while it was behaving normally.
    #[test]
    fn the_panel_bound_clears_three_stacked_page_reads() {
        assert!(
            super::super::PANEL_TIMEOUT.default_ms >= 3 * 30_000,
            "a call that chains act, settle and observe would be abandoned mid-flight"
        );
    }
}
