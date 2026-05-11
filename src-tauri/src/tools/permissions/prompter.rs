//! Permission prompter — Phase 4 oneshot router and concrete impls.
//!
//! Mirrors [`crate::agent_runtime::bridge::BridgeRouter`]: an
//! `Arc<DashMap<(turn_id, tool_name), oneshot::Sender<bool>>>` that
//! the [`TauriPermitter`] inserts into before emitting the
//! `"agent_permission_request"` event, and that the
//! `agent_grant_permission` Tauri command resolves when the user
//! decides.
//!
//! Three things stay deliberately separated:
//!
//! * **The trait** ([`super::Permitter`], re-export of
//!   [`crate::agent_runtime::tool_executor::Permitter`]) — what
//!   [`crate::agent_runtime::tool_executor::ToolRegistry::execute_with_permission`]
//!   talks to.
//! * **The router** ([`PermissionRouter`]) — pure book-keeping; no
//!   Tauri or async-trait at all. Tests use it directly.
//! * **The concrete impl** ([`TauriPermitter`] in production,
//!   [`MockPermitter`] in tests).

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::tool_executor::{Permitter, ToolError};

/// The Tauri event channel name the frontend listens on for
/// permission prompts. Hard-coded so the contract is explicit at
/// both ends — if you change this here, change it in the frontend
/// modal too. Sub-D's report calls this out as the parent integration
/// surface.
pub const PERMISSION_REQUEST_EVENT: &str = "agent_permission_request";

/// Convenience accessor for [`PERMISSION_REQUEST_EVENT`] so other
/// modules don't have to import the const directly. Reads slightly
/// nicer in code that emits the event.
#[must_use]
pub const fn permission_request_event_channel() -> &'static str {
    PERMISSION_REQUEST_EVENT
}

/// Wire payload of the `"agent_permission_request"` event.
///
/// Camel-cased to match the rest of the agent_v2 IPC surface (see
/// [`crate::agent_runtime::bridge::ToolBridgeRequest`]).
///
/// `tool_use_id` is the provider-issued id for **this specific
/// invocation** (Anthropic `toolu_…`, OpenAI `call_…`). The frontend
/// chat UI keys its streaming tool card and inline approval card on
/// the same id, so the card knows which timeline entry to attach the
/// approval buttons to. Without it, the modal renders against a
/// synthetic id that never matches a real tool card and the approval
/// UI silently never appears.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestPayload {
    pub turn_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
}

// ---------------------------------------------------------------------------
// PermissionRouter — `(turn_id, tool_name)` → oneshot table
// ---------------------------------------------------------------------------

/// Concurrent `(turn_id, tool_name) → oneshot::Sender<bool>` map.
///
/// Phase 4's analogue of [`crate::agent_runtime::bridge::BridgeRouter`].
/// One [`PermissionRouter`] is owned by the parent
/// `AgentRegistry` (added in the integration step) and shared
/// across turns. Each [`Permitter::request`] call:
///
/// 1. Creates a `oneshot` channel.
/// 2. Inserts the sender under `(turn_id, tool_name)`.
/// 3. Awaits the receiver.
///
/// The `agent_grant_permission` Tauri command in
/// [`crate::commands::agent_v2_permissions`] calls
/// [`PermissionRouter::resolve`] with the same key when the user
/// decides.
///
/// A drop-guard inside [`TauriPermitter::request`] removes the entry
/// from the map even if the request is cancelled, so the map cannot
/// leak.
#[derive(Default)]
pub struct PermissionRouter {
    pending: Arc<DashMap<(String, String), oneshot::Sender<bool>>>,
}

impl std::fmt::Debug for PermissionRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionRouter")
            .field("pending_count", &self.pending.len())
            .finish()
    }
}

impl PermissionRouter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh sender under `(turn_id, tool_name)` and hand
    /// back the matching receiver.
    ///
    /// Re-using an existing key replaces the previous sender —
    /// dropping it implicitly cancels the older request, which is
    /// the right policy if the frontend somehow asks the same tool
    /// twice in one turn.
    #[must_use]
    pub fn register(
        &self,
        turn_id: String,
        tool_name: String,
    ) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert((turn_id, tool_name), tx);
        rx
    }

    /// Look up the sender for `(turn_id, tool_name)` and resolve it
    /// with the user's verdict.
    ///
    /// Returns `Ok(())` on a clean resolution. Returns
    /// `Err(granted)` when no pending request matched (the request
    /// was already cancelled, never registered, or the executor
    /// dropped the receiver). The boolean is passed back so the
    /// caller (the Tauri command) can surface a meaningful error if
    /// desired.
    pub fn resolve(
        &self,
        turn_id: &str,
        tool_name: &str,
        granted: bool,
    ) -> Result<(), bool> {
        let key = (turn_id.to_string(), tool_name.to_string());
        let Some((_key, sender)) = self.pending.remove(&key) else {
            return Err(granted);
        };
        sender.send(granted).map_err(|_| granted)
    }

    /// Drop every pending oneshot for a turn. Used when a turn is
    /// cancelled or finishes — leaves no dangling senders to leak.
    pub fn drop_turn(&self, turn_id: &str) {
        self.pending.retain(|(t, _), _| t.as_str() != turn_id);
    }

    /// Total number of senders currently parked. Diagnostics only.
    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

/// Drop-guard that removes a `(turn_id, tool_name)` entry from a
/// [`PermissionRouter`] when it goes out of scope.
///
/// Guarantees the router never leaks an entry on cancellation or
/// panic inside [`TauriPermitter::request`] (or any other impl that
/// uses the router). Same shape as the bridge module's `PendingGuard`.
struct PendingGuard {
    pending: Arc<DashMap<(String, String), oneshot::Sender<bool>>>,
    key: Option<(String, String)>,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.pending.remove(&key);
        }
    }
}

// ---------------------------------------------------------------------------
// MockPermitter — synchronous in-memory verdict for tests
// ---------------------------------------------------------------------------

/// In-memory permitter used by the verify crate.
///
/// Construct with [`MockPermitter::granting`] / [`MockPermitter::denying`]
/// for the simple cases, or with [`MockPermitter::scripted`] for
/// per-call verdicts (vec popped from the front each call).
///
/// `wait_ms` makes the permitter park before resolving, exercising
/// the cancel-during-prompt path. Defaults to 0.
pub struct MockPermitter {
    verdict: parking_lot::Mutex<Verdict>,
    /// Records every call for assertions.
    pub calls: parking_lot::Mutex<Vec<MockCall>>,
    /// If `> 0`, sleep this long before returning the verdict so
    /// cancellation tests have a window to fire. The sleep is
    /// `tokio::select!`-ed against `cancel`.
    pub wait_ms: u64,
}

#[derive(Debug, Clone)]
pub struct MockCall {
    pub turn_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
}

enum Verdict {
    Constant(bool),
    Script(Vec<bool>),
    Error(String),
}

impl MockPermitter {
    #[must_use]
    pub fn granting() -> Self {
        Self {
            verdict: parking_lot::Mutex::new(Verdict::Constant(true)),
            calls: parking_lot::Mutex::new(Vec::new()),
            wait_ms: 0,
        }
    }

    #[must_use]
    pub fn denying() -> Self {
        Self {
            verdict: parking_lot::Mutex::new(Verdict::Constant(false)),
            calls: parking_lot::Mutex::new(Vec::new()),
            wait_ms: 0,
        }
    }

    #[must_use]
    pub fn scripted(script: Vec<bool>) -> Self {
        Self {
            verdict: parking_lot::Mutex::new(Verdict::Script(script)),
            calls: parking_lot::Mutex::new(Vec::new()),
            wait_ms: 0,
        }
    }

    /// Returns an error from `request` instead of a verdict — used
    /// to test that the dispatch path propagates [`ToolError`]s
    /// faithfully.
    #[must_use]
    pub fn erroring(message: impl Into<String>) -> Self {
        Self {
            verdict: parking_lot::Mutex::new(Verdict::Error(message.into())),
            calls: parking_lot::Mutex::new(Vec::new()),
            wait_ms: 0,
        }
    }

    /// Builder: park `ms` milliseconds before returning. Used by the
    /// cancel-during-prompt test. The wait is cancellable.
    #[must_use]
    pub fn with_wait_ms(mut self, ms: u64) -> Self {
        self.wait_ms = ms;
        self
    }

    pub fn call_count(&self) -> usize {
        self.calls.lock().len()
    }

    pub fn last_call(&self) -> Option<MockCall> {
        self.calls.lock().last().cloned()
    }
}

#[async_trait]
impl Permitter for MockPermitter {
    async fn request(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<bool, ToolError> {
        self.calls.lock().push(MockCall {
            turn_id: turn_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
        });

        if self.wait_ms > 0 {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(ToolError::Cancelled),
                () = tokio::time::sleep(Duration::from_millis(self.wait_ms)) => {}
            }
        } else if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let mut verdict = self.verdict.lock();
        match &mut *verdict {
            Verdict::Constant(b) => Ok(*b),
            Verdict::Script(v) => {
                if v.is_empty() {
                    Err(ToolError::Execution(
                        "MockPermitter script exhausted".into(),
                    ))
                } else {
                    Ok(v.remove(0))
                }
            }
            Verdict::Error(msg) => Err(ToolError::Execution(msg.clone())),
        }
    }
}

// ---------------------------------------------------------------------------
// TauriPermitter — production impl
// ---------------------------------------------------------------------------

/// Sink the production [`TauriPermitter`] calls when it needs to
/// emit the `"agent_permission_request"` event.
///
/// Splitting this out behind a trait keeps the production impl
/// testable with a recording mock and lets the verify crate skip
/// the Tauri dependency entirely (the verify crate flips the
/// `verify_only` feature on, which excludes the [`TauriPermitter`]
/// concrete struct below).
pub trait PermissionEmitter: Send + Sync + 'static {
    fn emit_permission_request(&self, payload: &PermissionRequestPayload);
}

/// Production [`Permitter`] backed by a [`PermissionRouter`] and
/// any [`PermissionEmitter`] (in production: a Tauri-emitting wrapper
/// around `AppHandle`; in tests: a recording mock).
///
/// On [`Self::request`]:
///
/// 1. If `cancel` already fired, return [`ToolError::Cancelled`]
///    without registering anything.
/// 2. Register a oneshot in the router under `(turn_id, tool_name)`.
/// 3. Emit the `"agent_permission_request"` event via the sink
///    (production: Tauri `AppHandle::emit`).
/// 4. `tokio::select!` on:
///    - `cancel.cancelled()` → [`ToolError::Cancelled`]
///    - The oneshot receiver → the user's verdict.
/// 5. The drop-guard cleans the router entry on every exit path.
///
/// The frontend posts the verdict through the
/// `agent_grant_permission` command in
/// [`crate::commands::agent_v2_permissions`].
#[cfg(not(feature = "verify_only"))]
pub struct TauriPermitter {
    router: Arc<PermissionRouter>,
    emitter: Arc<dyn PermissionEmitter>,
}

#[cfg(not(feature = "verify_only"))]
impl std::fmt::Debug for TauriPermitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriPermitter")
            .field("pending_count", &self.router.pending_count())
            .finish_non_exhaustive()
    }
}

#[cfg(not(feature = "verify_only"))]
impl TauriPermitter {
    #[must_use]
    pub fn new(router: Arc<PermissionRouter>, emitter: Arc<dyn PermissionEmitter>) -> Self {
        Self { router, emitter }
    }

    #[must_use]
    pub fn router(&self) -> &Arc<PermissionRouter> {
        &self.router
    }
}

#[cfg(not(feature = "verify_only"))]
#[async_trait]
impl Permitter for TauriPermitter {
    async fn request(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<bool, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let key = (turn_id.to_string(), tool_name.to_string());
        let receiver = self.router.register(key.0.clone(), key.1.clone());

        let _guard = PendingGuard {
            pending: self.router.pending.clone(),
            key: Some(key),
        };

        let payload = PermissionRequestPayload {
            turn_id: turn_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
        };
        eprintln!(
            "[TauriPermitter] emitting {PERMISSION_REQUEST_EVENT} for turn={turn_id} tool={tool_name} tool_use_id={tool_use_id}"
        );
        self.emitter.emit_permission_request(&payload);

        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(ToolError::Cancelled),
            outcome = receiver => match outcome {
                Ok(granted) => Ok(granted),
                Err(_recv_err) => Err(ToolError::Execution(
                    "permission router dropped the response channel".into(),
                )),
            },
        }
    }
}

// `RouterPermitter` is the verify-friendly half of `TauriPermitter`:
// the same async logic but no Tauri-feature gate. The verify crate
// instantiates this directly with an in-memory emitter to exercise
// the timeout/cancel paths end-to-end. Production uses
// `TauriPermitter` (which is just this exact code path with the
// `verify_only` feature off).
#[doc(hidden)]
pub struct RouterPermitter {
    pub router: Arc<PermissionRouter>,
    pub emitter: Arc<dyn PermissionEmitter>,
}

impl std::fmt::Debug for RouterPermitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouterPermitter")
            .field("pending_count", &self.router.pending_count())
            .finish_non_exhaustive()
    }
}

impl RouterPermitter {
    #[must_use]
    pub fn new(router: Arc<PermissionRouter>, emitter: Arc<dyn PermissionEmitter>) -> Self {
        Self { router, emitter }
    }

    #[must_use]
    pub fn router(&self) -> &Arc<PermissionRouter> {
        &self.router
    }
}

#[async_trait]
impl Permitter for RouterPermitter {
    async fn request(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<bool, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let key = (turn_id.to_string(), tool_name.to_string());
        let receiver = self.router.register(key.0.clone(), key.1.clone());

        let _guard = PendingGuard {
            pending: self.router.pending.clone(),
            key: Some(key),
        };

        let payload = PermissionRequestPayload {
            turn_id: turn_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
        };
        self.emitter.emit_permission_request(&payload);

        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(ToolError::Cancelled),
            outcome = receiver => match outcome {
                Ok(granted) => Ok(granted),
                Err(_recv_err) => Err(ToolError::Execution(
                    "permission router dropped the response channel".into(),
                )),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::time::timeout;

    /// Recording emitter used by the integration tests.
    #[derive(Default)]
    struct RecordingEmitter {
        seen: Mutex<Vec<PermissionRequestPayload>>,
    }

    impl PermissionEmitter for RecordingEmitter {
        fn emit_permission_request(&self, payload: &PermissionRequestPayload) {
            self.seen.lock().unwrap().push(payload.clone());
        }
    }

    #[test]
    fn router_register_resolve_round_trip() {
        let router = PermissionRouter::new();
        let mut rx = router.register("t".into(), "shell_execute".into());
        router.resolve("t", "shell_execute", true).expect("resolve");
        assert_eq!(rx.try_recv().expect("oneshot fulfilled"), true);
        assert_eq!(router.pending_count(), 0);
    }

    #[test]
    fn router_resolve_unknown_key_returns_verdict() {
        let router = PermissionRouter::new();
        let returned = router
            .resolve("missing", "missing", true)
            .expect_err("must bounce");
        assert_eq!(returned, true, "verdict echoed back");
    }

    #[test]
    fn router_drop_turn_clears_only_matching_entries() {
        let router = PermissionRouter::new();
        let _rx_a = router.register("turn-a".into(), "t1".into());
        let _rx_b = router.register("turn-b".into(), "t1".into());
        let _rx_c = router.register("turn-a".into(), "t2".into());
        assert_eq!(router.pending_count(), 3);
        router.drop_turn("turn-a");
        assert_eq!(router.pending_count(), 1);
    }

    #[tokio::test]
    async fn mock_permitter_records_and_returns() {
        let m = MockPermitter::granting();
        let granted = m
            .request(
                "t-1",
                "shell_execute",
                &serde_json::json!({"command": "ls"}),
                CancellationToken::new(),
            )
            .await
            .expect("granted");
        assert!(granted);
        assert_eq!(m.call_count(), 1);
        let last = m.last_call().expect("call");
        assert_eq!(last.tool_name, "shell_execute");
    }

    #[tokio::test]
    async fn mock_permitter_denies() {
        let m = MockPermitter::denying();
        let granted = m
            .request(
                "t",
                "tu",
                "x",
                &serde_json::Value::Null,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!granted);
    }

    #[tokio::test]
    async fn mock_permitter_scripted_pops_in_order() {
        let m = MockPermitter::scripted(vec![true, false, true]);
        let cancel = CancellationToken::new();
        assert_eq!(
            m.request("t", "tu", "x", &serde_json::Value::Null, cancel.clone())
                .await
                .unwrap(),
            true
        );
        assert_eq!(
            m.request("t", "tu", "x", &serde_json::Value::Null, cancel.clone())
                .await
                .unwrap(),
            false
        );
        assert_eq!(
            m.request("t", "tu", "x", &serde_json::Value::Null, cancel)
                .await
                .unwrap(),
            true
        );
    }

    #[tokio::test]
    async fn router_permitter_grant_round_trip() {
        let router = Arc::new(PermissionRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let permitter =
            RouterPermitter::new(router.clone(), emitter.clone());

        let router_clone = router.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                if router_clone.pending_count() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            router_clone
                .resolve("turn-1", "shell_execute", true)
                .expect("resolve");
        });

        let granted = timeout(
            Duration::from_secs(2),
            permitter.request(
                "turn-1",
                "tooluse-1",
                "shell_execute",
                &serde_json::json!({"command":"ls"}),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("did not time out")
        .expect("ok");
        assert!(granted);

        let seen = emitter.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].turn_id, "turn-1");
        assert_eq!(seen[0].tool_name, "shell_execute");
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn router_permitter_deny_round_trip() {
        let router = Arc::new(PermissionRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let permitter =
            RouterPermitter::new(router.clone(), emitter);

        let router_clone = router.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                if router_clone.pending_count() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            router_clone
                .resolve("turn-2", "shell_execute", false)
                .expect("resolve");
        });

        let granted = timeout(
            Duration::from_secs(2),
            permitter.request(
                "turn-2",
                "tooluse-2",
                "shell_execute",
                &serde_json::Value::Null,
                CancellationToken::new(),
            ),
        )
        .await
        .expect("did not time out")
        .expect("ok");
        assert!(!granted);
    }

    #[tokio::test]
    async fn router_permitter_short_circuits_on_pre_cancel() {
        let router = Arc::new(PermissionRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let permitter =
            RouterPermitter::new(router.clone(), emitter.clone());

        let cancel = CancellationToken::new();
        cancel.cancel();

        let err = permitter
            .request(
                "turn-3",
                "tooluse-3",
                "shell_execute",
                &serde_json::Value::Null,
                cancel,
            )
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        // No event emitted because we returned before registering.
        assert_eq!(emitter.seen.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn router_permitter_cancels_mid_prompt() {
        let router = Arc::new(PermissionRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let permitter =
            RouterPermitter::new(router.clone(), emitter);
        let cancel = CancellationToken::new();

        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_clone.cancel();
        });

        let err = timeout(
            Duration::from_secs(2),
            permitter.request(
                "turn-4",
                "tooluse-4",
                "shell_execute",
                &serde_json::Value::Null,
                cancel,
            ),
        )
        .await
        .expect("did not time out")
        .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        // Drop-guard cleaned up.
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn router_permitter_handles_router_dropping_sender() {
        let router = Arc::new(PermissionRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let permitter =
            RouterPermitter::new(router.clone(), emitter);

        let router_clone = router.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                if router_clone.pending_count() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            router_clone.drop_turn("turn-5");
        });

        let err = timeout(
            Duration::from_secs(2),
            permitter.request(
                "turn-5",
                "tooluse-5",
                "shell_execute",
                &serde_json::Value::Null,
                CancellationToken::new(),
            ),
        )
        .await
        .expect("did not time out")
        .expect_err("must error");
        match err {
            ToolError::Execution(msg) => {
                assert!(msg.contains("dropped"), "got: {msg}");
            }
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    #[test]
    fn permission_request_payload_serializes_to_camel_case() {
        let payload = PermissionRequestPayload {
            turn_id: "t-1".into(),
            tool_name: "shell_execute".into(),
            input: serde_json::json!({"command":"ls"}),
        };
        let s = serde_json::to_string(&payload).expect("serialize");
        assert!(s.contains("\"turnId\":\"t-1\""), "got: {s}");
        assert!(s.contains("\"toolName\":\"shell_execute\""), "got: {s}");
        assert!(!s.contains("\"turn_id\""), "snake_case leaked: {s}");
    }
}
