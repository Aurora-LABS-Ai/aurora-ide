//! Frontend tool-execution bridge — Phase 2.3.
//!
//! In Phase 2.3 the runtime does not own any tool implementations.
//! Aurora's 24+ tool executors still live in the TypeScript layer
//! (`src/tools/executors/*.ts`). To keep the agent loop in Rust while
//! re-using those executors, every advertised tool from
//! [`AgentChatRequest::tools`](super::ipc::AgentChatRequest::tools) is
//! registered as a [`FrontendBridgeExecutor`]. When the model calls
//! one of those tools, the runtime:
//!
//! 1. Builds a [`ToolBridgeRequest`] envelope and
//! 2. Emits it over the `agent_tool_pending` Tauri event channel via
//!    the [`BridgeEmitter`] passed in at executor construction.
//! 3. Parks on a [`tokio::sync::oneshot::Receiver`] that the
//!    [`BridgeRouter`] handed out when the executor was built.
//! 4. The frontend processes the request through its existing tool
//!    runner and posts the result back via the
//!    `agent_post_tool_result` Tauri command — that command looks the
//!    sender up in the [`BridgeRouter`] and resolves the oneshot.
//!
//! The whole flow is wrapped in `tokio::select!` against the
//! `cancel_token` so a mid-tool agent_cancel returns
//! [`ToolError::Cancelled`] promptly without waiting for the frontend
//! to time out its own UI.
//!
//! Phase 3 will replace selected `FrontendBridgeExecutor` registrations
//! with native Rust [`ToolExecutor`] impls; the bridge stays in place
//! for tools that remain frontend-driven (anything that touches the
//! Monaco editor instance, for instance).

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::api_client::ToolSchema;
use super::ipc::AllowedTool;
use super::tool_executor::{ToolContext, ToolError, ToolExecutor};

/// Frontend → backend reply for one in-flight tool call.
///
/// Constructed by the `agent_post_tool_result` Tauri command and
/// shipped through the oneshot the [`BridgeRouter`] is holding.
///
/// `is_error` mirrors the Anthropic `ToolResult.is_error` field —
/// `true` means the runtime should set `is_error: Some(true)` on the
/// emitted [`super::types::ContentBlock::ToolResult`] block.
#[derive(Debug, Clone)]
pub struct ToolBridgeResponse {
    /// Stringified tool result (or error message). Forwarded
    /// verbatim into the next API request as the `content` field of
    /// a `ToolResult` block.
    pub content: String,
    /// Whether the frontend treated the call as an error.
    pub is_error: bool,
}

/// Wire payload for the `agent_tool_pending` event.
///
/// The frontend listens on `agent_tool_pending` and matches by
/// `(turn_id, tool_use_id)`. Camel-cased to match the Phase 2.3
/// `AgentChatRequest` shape — Sub-B writes a TS interface against
/// these field names directly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolBridgeRequest {
    pub turn_id: String,
    pub tool_use_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Backend → frontend event sink for the bridge.
///
/// Pulled out of [`crate::commands::agent_v2::EventEmitter`] as a
/// minimal surface so [`FrontendBridgeExecutor`] doesn't have to know
/// about `AgentEventEnvelope` plumbing — it only needs to emit the
/// `tool_pending` channel. Implemented by `TauriEmitter` in
/// `commands/agent_v2.rs`.
pub trait BridgeEmitter: Send + Sync + 'static {
    fn emit_tool_pending(&self, request: &ToolBridgeRequest);
}

/// Concurrent `(turn_id, tool_use_id) → oneshot::Sender` map.
///
/// One [`BridgeRouter`] is owned by the
/// [`crate::commands::agent_v2::AgentRegistry`] and shared across
/// turns. Each [`FrontendBridgeExecutor::execute`] call:
///
/// 1. Creates a `oneshot` channel.
/// 2. Inserts the sender under `(turn_id, tool_use_id)`.
/// 3. Awaits the receiver.
///
/// The `agent_post_tool_result` command on the Tauri side calls
/// [`BridgeRouter::resolve`] with the same key to fulfil the oneshot.
///
/// A drop-guard removes the entry from the map even if the executor
/// is cancelled or the result never arrives, so the map cannot leak.
#[derive(Default)]
pub struct BridgeRouter {
    pending: Arc<DashMap<(String, String), oneshot::Sender<ToolBridgeResponse>>>,
}

impl std::fmt::Debug for BridgeRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeRouter")
            .field("pending_count", &self.pending.len())
            .finish()
    }
}

impl BridgeRouter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh sender under `(turn_id, tool_use_id)` and
    /// hand back the matching receiver.
    ///
    /// Re-using an existing key replaces the previous sender —
    /// dropping it implicitly cancels whoever was waiting on the
    /// older oneshot, which is the right policy if the frontend
    /// somehow asked for the same tool_use_id twice.
    #[must_use]
    pub fn register(
        &self,
        turn_id: String,
        tool_use_id: String,
    ) -> oneshot::Receiver<ToolBridgeResponse> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert((turn_id, tool_use_id), tx);
        rx
    }

    /// Look up the sender for `(turn_id, tool_use_id)` and resolve
    /// it. Returns `Err(response)` if no pending call matched
    /// (already cancelled, never registered, or the executor dropped
    /// the receiver) — Phase 5 will surface this on the
    /// `agent_post_tool_result` reply.
    pub fn resolve(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        response: ToolBridgeResponse,
    ) -> Result<(), ToolBridgeResponse> {
        let key = (turn_id.to_string(), tool_use_id.to_string());
        let Some((_key, sender)) = self.pending.remove(&key) else {
            return Err(response);
        };
        sender.send(response)
    }

    /// Drop every pending oneshot for a turn. Used when a turn is
    /// cancelled or finishes — leaves no dangling senders to leak.
    pub fn drop_turn(&self, turn_id: &str) {
        self.pending.retain(|(t, _), _| t.as_str() != turn_id);
    }

    /// Total number of senders currently parked. For diagnostics.
    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

/// Drop-guard that removes a `(turn_id, tool_use_id)` entry from a
/// [`BridgeRouter`] when it goes out of scope.
///
/// Guarantees the router never leaks an entry even on cancellation
/// or panic inside `execute`.
struct PendingGuard {
    pending: Arc<DashMap<(String, String), oneshot::Sender<ToolBridgeResponse>>>,
    key: Option<(String, String)>,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.pending.remove(&key);
        }
    }
}

/// One [`ToolExecutor`] that delegates to the frontend bridge.
///
/// Built per turn from one [`AllowedTool`] entry. Holds:
///
/// - The tool's name + schema (advertised verbatim to the model).
/// - `turn_id` — used as half of the oneshot key.
/// - An [`Arc`] to the per-app [`BridgeRouter`] so the executor can
///   register its oneshot.
/// - An [`Arc<dyn BridgeEmitter>`] so the executor can ship the
///   `agent_tool_pending` event without knowing about `AppHandle`.
/// - A turn-scoped `cancel_token` so an `agent_cancel` short-circuits
///   the wait via `tokio::select!`.
pub struct FrontendBridgeExecutor {
    tool: AllowedTool,
    turn_id: String,
    router: Arc<BridgeRouter>,
    emitter: Arc<dyn BridgeEmitter>,
    cancel_token: CancellationToken,
}

impl std::fmt::Debug for FrontendBridgeExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrontendBridgeExecutor")
            .field("name", &self.tool.name)
            .field("turn_id", &self.turn_id)
            .field("cancelled", &self.cancel_token.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl FrontendBridgeExecutor {
    #[must_use]
    pub fn new(
        tool: AllowedTool,
        turn_id: String,
        router: Arc<BridgeRouter>,
        emitter: Arc<dyn BridgeEmitter>,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            tool,
            turn_id,
            router,
            emitter,
            cancel_token,
        }
    }
}

#[async_trait]
impl ToolExecutor for FrontendBridgeExecutor {
    fn name(&self) -> &str {
        self.tool.name.as_str()
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.tool.name.clone(),
            description: self.tool.description.clone(),
            input_schema: self.tool.parameters.clone(),
        }
    }

    fn uses_frontend_lifecycle(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        context: &ToolContext,
    ) -> Result<String, ToolError> {
        // Cheap pre-check: don't even register a oneshot if cancel
        // already fired — saves the frontend a phantom event.
        if self.cancel_token.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let key = (self.turn_id.clone(), context.tool_call_id.clone());
        let receiver = self.router.register(key.0.clone(), key.1.clone());

        // Drop-guard guarantees the entry is removed even on panic
        // or cancellation.
        let _guard = PendingGuard {
            pending: self.router.pending.clone(),
            key: Some(key),
        };

        // Notify the frontend AFTER we've registered the oneshot —
        // otherwise the frontend could resolve it before the entry
        // exists in the map.
        let pending = ToolBridgeRequest {
            turn_id: self.turn_id.clone(),
            tool_use_id: context.tool_call_id.clone(),
            name: self.tool.name.clone(),
            input,
        };
        self.emitter.emit_tool_pending(&pending);

        // Park until either:
        // - the frontend posts a result via `agent_post_tool_result`
        //   (which resolves the oneshot through `BridgeRouter::resolve`)
        // - the cancel_token fires (agent_cancel command)
        // - the receiver is closed without a value (router dropped
        //   the sender, e.g. during shutdown).
        tokio::select! {
            biased;
            () = self.cancel_token.cancelled() => Err(ToolError::Cancelled),
            outcome = receiver => match outcome {
                Ok(response) => {
                    if response.is_error {
                        Err(ToolError::Execution(response.content))
                    } else {
                        Ok(response.content)
                    }
                }
                Err(_recv_err) => Err(ToolError::Execution(
                    "frontend bridge dropped the response channel".into(),
                )),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::time::timeout;

    /// Recording emitter used to assert the event payload shape.
    #[derive(Default)]
    struct RecordingEmitter {
        seen: Mutex<Vec<ToolBridgeRequest>>,
    }

    impl BridgeEmitter for RecordingEmitter {
        fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
            self.seen
                .lock()
                .expect("recording emitter mutex")
                .push(request.clone());
        }
    }

    fn allowed_tool(name: &str) -> AllowedTool {
        AllowedTool {
            name: name.into(),
            description: format!("test tool {name}"),
            parameters: serde_json::json!({"type":"object"}),
        }
    }

    fn ctx(tool_use_id: &str) -> ToolContext {
        ToolContext {
            turn_id: "turn-1".into(),
            tool_call_id: tool_use_id.into(),
            session_id: "session-1".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[test]
    fn router_register_resolve_round_trip() {
        let router = BridgeRouter::new();
        let mut rx = router.register("t".into(), "c".into());
        // Inside async-free test we read via `try_recv` after
        // resolving synchronously.
        router
            .resolve(
                "t",
                "c",
                ToolBridgeResponse {
                    content: "result".into(),
                    is_error: false,
                },
            )
            .expect("resolve");
        let response = rx.try_recv().expect("oneshot fulfilled");
        assert_eq!(response.content, "result");
        assert!(!response.is_error);
        assert_eq!(router.pending_count(), 0);
    }

    #[test]
    fn router_resolve_unknown_key_returns_response() {
        let router = BridgeRouter::new();
        let response = ToolBridgeResponse {
            content: "no one home".into(),
            is_error: true,
        };
        let returned = router
            .resolve("missing", "missing", response)
            .expect_err("must bounce");
        assert_eq!(returned.content, "no one home");
        assert!(returned.is_error);
    }

    #[test]
    fn router_drop_turn_clears_only_matching_entries() {
        let router = BridgeRouter::new();
        let _rx_a = router.register("turn-a".into(), "c1".into());
        let _rx_b = router.register("turn-b".into(), "c1".into());
        let _rx_c = router.register("turn-a".into(), "c2".into());
        assert_eq!(router.pending_count(), 3);
        router.drop_turn("turn-a");
        assert_eq!(router.pending_count(), 1, "only turn-b should remain");
    }

    #[test]
    fn router_re_register_overwrites_previous_sender() {
        let router = BridgeRouter::new();
        let mut rx_old = router.register("t".into(), "c".into());
        let _rx_new = router.register("t".into(), "c".into());
        // The old sender was dropped — old receiver yields a closed-channel error.
        match rx_old.try_recv() {
            Err(oneshot::error::TryRecvError::Closed) => {}
            other => panic!("expected closed, got {other:?}"),
        }
        assert_eq!(router.pending_count(), 1);
    }

    #[test]
    fn bridge_request_serializes_to_camel_case_keys() {
        let req = ToolBridgeRequest {
            turn_id: "t-1".into(),
            tool_use_id: "call-9".into(),
            name: "file_read".into(),
            input: serde_json::json!({"path":"a.rs"}),
        };
        let s = serde_json::to_string(&req).expect("serialize");
        assert!(s.contains("\"turnId\":\"t-1\""), "got: {s}");
        assert!(s.contains("\"toolUseId\":\"call-9\""), "got: {s}");
        assert!(s.contains("\"name\":\"file_read\""), "got: {s}");
        assert!(s.contains("\"input\""), "got: {s}");
        assert!(!s.contains("\"turn_id\""), "snake_case leaked: {s}");
        assert!(!s.contains("\"tool_use_id\""), "snake_case leaked: {s}");
    }

    #[tokio::test]
    async fn executor_emits_pending_event_then_resolves_via_router() {
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let executor = FrontendBridgeExecutor::new(
            allowed_tool("file_read"),
            "turn-1".into(),
            router.clone(),
            emitter.clone(),
            CancellationToken::new(),
        );

        // Resolve the oneshot from another task — simulates the
        // frontend calling `agent_post_tool_result`.
        let router_clone = router.clone();
        tokio::spawn(async move {
            // Yield once so the executor has time to register.
            tokio::task::yield_now().await;
            // Wait briefly for the registration to land.
            for _ in 0..50 {
                if router_clone.pending_count() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            router_clone
                .resolve(
                    "turn-1",
                    "call-1",
                    ToolBridgeResponse {
                        content: "the file contents".into(),
                        is_error: false,
                    },
                )
                .expect("resolve");
        });

        let result = timeout(
            Duration::from_secs(2),
            executor.execute(serde_json::json!({"path":"a.rs"}), &ctx("call-1")),
        )
        .await
        .expect("did not time out")
        .expect("ok");
        assert_eq!(result, "the file contents");

        // Emitter saw exactly one pending event with the right payload.
        let seen = emitter.seen.lock().expect("emitter mutex");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].turn_id, "turn-1");
        assert_eq!(seen[0].tool_use_id, "call-1");
        assert_eq!(seen[0].name, "file_read");
        assert_eq!(seen[0].input, serde_json::json!({"path":"a.rs"}));
        // Router cleaned up its entry on success.
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn executor_returns_execution_error_when_response_is_error() {
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let executor = FrontendBridgeExecutor::new(
            allowed_tool("file_read"),
            "turn-2".into(),
            router.clone(),
            emitter,
            CancellationToken::new(),
        );

        let router_clone = router.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                if router_clone.pending_count() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            router_clone
                .resolve(
                    "turn-2",
                    "call-2",
                    ToolBridgeResponse {
                        content: "ENOENT: no such file".into(),
                        is_error: true,
                    },
                )
                .expect("resolve");
        });

        let err = timeout(
            Duration::from_secs(2),
            executor.execute(serde_json::json!({}), &ctx("call-2")),
        )
        .await
        .expect("did not time out")
        .expect_err("must error");
        match err {
            ToolError::Execution(msg) => {
                assert!(msg.contains("ENOENT"), "got: {msg}");
            }
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn executor_short_circuits_when_pre_cancelled() {
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let executor = FrontendBridgeExecutor::new(
            allowed_tool("file_read"),
            "turn-3".into(),
            router.clone(),
            emitter.clone(),
            cancel,
        );

        let err = executor
            .execute(serde_json::json!({}), &ctx("call-3"))
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        // No pending event was emitted because the executor returned
        // before registration.
        assert_eq!(emitter.seen.lock().expect("emitter mutex").len(), 0);
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn executor_returns_cancelled_when_cancel_fires_mid_wait() {
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let cancel = CancellationToken::new();
        let executor = FrontendBridgeExecutor::new(
            allowed_tool("slow_tool"),
            "turn-4".into(),
            router.clone(),
            emitter,
            cancel.clone(),
        );

        // Cancel mid-wait without ever resolving the oneshot.
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_clone.cancel();
        });

        let err = timeout(
            Duration::from_secs(2),
            executor.execute(serde_json::json!({}), &ctx("call-4")),
        )
        .await
        .expect("did not time out")
        .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        // Drop-guard cleaned the router up.
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn executor_handles_router_dropping_sender() {
        // If the router clears the entry without sending (e.g.
        // shutdown), the receiver yields a `RecvError` and the
        // executor surfaces a meaningful Execution error.
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let executor = FrontendBridgeExecutor::new(
            allowed_tool("file_read"),
            "turn-5".into(),
            router.clone(),
            emitter,
            CancellationToken::new(),
        );

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
            executor.execute(serde_json::json!({}), &ctx("call-5")),
        )
        .await
        .expect("did not time out")
        .expect_err("must error");
        match err {
            ToolError::Execution(msg) => assert!(msg.contains("dropped"), "got: {msg}"),
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn executor_schema_round_trips_allowed_tool_fields() {
        let router = Arc::new(BridgeRouter::new());
        let emitter = Arc::new(RecordingEmitter::default());
        let tool = AllowedTool {
            name: "file_write".into(),
            description: "Write a file".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "contents": { "type": "string" } },
                "required": ["path", "contents"],
            }),
        };
        let executor = FrontendBridgeExecutor::new(
            tool.clone(),
            "turn-x".into(),
            router,
            emitter,
            CancellationToken::new(),
        );
        assert_eq!(executor.name(), "file_write");
        let schema = executor.schema();
        assert_eq!(schema.name, "file_write");
        assert_eq!(schema.description, "Write a file");
        assert_eq!(schema.input_schema, tool.parameters);
    }
}
