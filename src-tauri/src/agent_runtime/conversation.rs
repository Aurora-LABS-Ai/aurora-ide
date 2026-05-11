//! Conversation runtime — the heart of the Rust agent loop.
//!
//! [`ConversationRuntime::run_turn`] is the moral equivalent of
//! `AgentService.chat()` in `src/services/agent-service.ts`, modelled
//! on `claw-code/rust/crates/runtime/src/conversation.rs`. One call
//! drives a single user turn end-to-end:
//!
//! 1. Append the user message to the [`Session`].
//! 2. Stream the assistant response from the [`StreamingApiClient`],
//!    forwarding every [`AssistantEvent`] out to the frontend via the
//!    caller-provided event sink.
//! 3. If the assistant emitted [`ContentBlock::ToolUse`] blocks, look
//!    each tool up in the [`ToolRegistry`], execute it, and append a
//!    matching [`ContentBlock::ToolResult`] block to the session.
//! 4. Loop until the assistant returns a `MessageStop` with no
//!    pending tool calls (i.e. `stop_reason != "tool_use"`).
//!
//! Phase 2.1 lands the loop **with a trait-driven boundary**: the
//! runtime never touches reqwest, never touches the disk, and is
//! provider-agnostic. Phase 2.2 wires the existing `provider_kernel`
//! behind the [`StreamingApiClient`] trait. Phase 2.3 does the
//! frontend cutover.
//!
//! ## Cancellation contract
//!
//! The runtime checks `cancel_token` at three points:
//!
//! - **Before** each API call (cheap fast-path — no socket opened).
//! - **During** each API call via `tokio::select!` inside the impl.
//! - **Before** each tool dispatch (so a cancel between tools doesn't
//!   waste an extra `execute()`).
//!
//! On cancel the runtime returns [`RuntimeError::Cancelled`] **without
//! emitting an `Error` event** — the frontend already knows it asked
//! to stop.
//!
//! ## Iteration cap
//!
//! [`RuntimeConfig::max_iterations`] is `Option<u32>` — `None` means
//! no cap (Aurora's user-visible default). Honoured per the user's
//! existing "no tool call cap at all" requirement.
//!
//! [`ContentBlock::ToolUse`]: super::types::ContentBlock::ToolUse
//! [`ContentBlock::ToolResult`]: super::types::ContentBlock::ToolResult

#![allow(dead_code)]

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::api_client::{ApiRequest, StreamingApiClient};
use super::error::RuntimeError;
use super::events::{AssistantEvent, TurnCompletion};
use super::hooks::{Hook, NoopHook, ToolHookResult};
use super::ipc::AgentEventEnvelope;
use super::session::Session;
use super::tool_executor::{ToolContext, ToolError, ToolRegistry};
use super::types::{ContentBlock, ConversationMessage, MessageRole, TokenUsage};

/// Configuration for one [`ConversationRuntime`] instance.
///
/// Held by value (cheap to clone) so the runtime can be re-built per
/// thread without sharing state. Provider/tool selection lives outside
/// — pass different `Arc<dyn StreamingApiClient>` / `Arc<ToolRegistry>`
/// pairs to swap behaviours.
///
/// Phase 2.3 wires the per-turn overrides from
/// [`crate::agent_runtime::ipc::AgentChatRequest`] into a fresh
/// [`RuntimeConfig`] each turn — `TurnDriver::run_turn` builds one
/// from the active workspace defaults and overlays the request's
/// `system_prompt`, `temperature`, `max_output_tokens`,
/// `thinking_enabled` fields before constructing the runtime.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Hard cap on assistant↔tool round trips per turn. `None` means
    /// "let the model run as long as it wants" — the user's preference
    /// and the documented Aurora default after the tool-cap removal.
    pub max_iterations: Option<u32>,

    /// Optional system prompt prepended on every API call. Aurora's
    /// `agent-prompt.ts` composer feeds this string in.
    pub system_prompt: Option<String>,

    /// Default `max_output_tokens` per API call when the caller
    /// doesn't override per-turn.
    pub default_max_output_tokens: u32,

    /// Whether to enable extended thinking on every call. Wired
    /// through the `ApiRequest::thinking_enabled` flag — the impl
    /// silently drops it on providers that don't support thinking.
    pub thinking_enabled: bool,

    /// Default sampling temperature applied to every API call.
    /// `None` defers to the provider preset (some, like DeepSeek's
    /// reasoner, ignore the field entirely). Phase 2.3 lets the
    /// per-turn `AgentChatRequest::temperature` override this.
    pub default_temperature: Option<f32>,

    /// IDE-context blob (open files, selection, cursor, …) the
    /// runtime wraps in `<ide_context>...</ide_context>` and
    /// prepends to the LATEST user message **only when assembling
    /// the API request**. The persisted JSONL keeps the user's
    /// message verbatim. Empty/`None` means "no IDE context for
    /// this turn".
    pub ide_context: Option<String>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            max_iterations: None,
            system_prompt: None,
            default_max_output_tokens: 8192,
            thinking_enabled: false,
            default_temperature: None,
            ide_context: None,
        }
    }
}

/// One turn driver bound to a provider and a tool catalogue.
///
/// Cheap to clone — internals are `Arc`-backed.
#[derive(Clone)]
pub struct ConversationRuntime {
    api_client: Arc<dyn StreamingApiClient>,
    tools: Arc<ToolRegistry>,
    config: RuntimeConfig,
    /// Phase 4 hook surface. Defaults to a [`NoopHook`] — every
    /// existing `ConversationRuntime::new` call site is unaffected.
    /// Replace via [`ConversationRuntime::with_hook`].
    hook: Arc<dyn Hook>,
}

impl std::fmt::Debug for ConversationRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationRuntime")
            .field("tools", &self.tools)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl ConversationRuntime {
    #[must_use]
    pub fn new(
        api_client: Arc<dyn StreamingApiClient>,
        tools: Arc<ToolRegistry>,
        config: RuntimeConfig,
    ) -> Self {
        Self {
            api_client,
            tools,
            config,
            hook: Arc::new(NoopHook),
        }
    }

    /// Builder-style override that swaps the runtime's no-op hook for
    /// a real one. Use [`super::hooks::HookChain`] to install
    /// multiple hooks at once.
    #[must_use]
    pub fn with_hook(mut self, hook: Arc<dyn Hook>) -> Self {
        self.hook = hook;
        self
    }

    /// Drive one user turn end-to-end. See module doc for the loop
    /// shape and cancellation contract.
    ///
    /// Streamed events are forwarded out via `event_sink` wrapped in
    /// [`AgentEventEnvelope`] with a monotonic per-turn `seq` number.
    /// The `seq` is re-zeroed for every call.
    ///
    /// Returns a [`TurnCompletion`] summary on a clean stop; returns
    /// the relevant [`RuntimeError`] variant on failure.
    pub async fn run_turn(
        &self,
        session: &mut Session,
        user_message: ConversationMessage,
        event_sink: mpsc::Sender<AgentEventEnvelope>,
        cancel_token: CancellationToken,
    ) -> Result<TurnCompletion, RuntimeError> {
        self.run_turn_with_id(
            generate_turn_id(),
            session,
            user_message,
            event_sink,
            cancel_token,
        )
        .await
    }

    /// Drive one user turn using the caller-supplied turn id.
    ///
    /// Tauri's `agent_chat_v2` command receives a frontend-generated
    /// turn id and every streamed event must use that same id so the
    /// WebView can correlate `agent_event`, `agent_turn_complete`,
    /// `agent_turn_error`, permission, and bridge-tool messages.
    pub async fn run_turn_with_id(
        &self,
        turn_id: String,
        session: &mut Session,
        user_message: ConversationMessage,
        event_sink: mpsc::Sender<AgentEventEnvelope>,
        cancel_token: CancellationToken,
    ) -> Result<TurnCompletion, RuntimeError> {
        let mut seq: u64 = 0;

        // 1. Record the user input in history.
        session.append_message(user_message);

        let mut iterations: u32 = 0;
        let mut total_usage = TokenUsage::default();
        let mut assistant_messages = Vec::<ConversationMessage>::new();
        let mut tool_results = Vec::<ConversationMessage>::new();
        let stop_reason: String;

        loop {
            iterations = iterations.saturating_add(1);

            // Optional iteration cap.
            if let Some(max) = self.config.max_iterations {
                if iterations > max {
                    let envelope = AgentEventEnvelope {
                        turn_id: turn_id.clone(),
                        seq,
                        event: AssistantEvent::Error {
                            message: format!("max iterations exceeded: {max}"),
                            recoverable: false,
                        },
                    };
                    let _ = event_sink.send(envelope).await;
                    return Err(RuntimeError::InvalidState(format!(
                        "exceeded max_iterations: {max}"
                    )));
                }
            }

            // Cheap cancel check before opening a socket.
            if cancel_token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }

            // ── Stream one assistant message ───────────────────────
            let model = session.model.clone().unwrap_or_default();
            let tool_schemas = self.tools.schemas();

            // Internal event channel: API impl pushes `AssistantEvent`
            // onto `api_tx`; a forwarder task wraps each in an
            // envelope and pushes it onto the caller's sink.
            let (api_tx, api_rx) = mpsc::channel::<AssistantEvent>(64);

            let forwarder = spawn_event_forwarder(turn_id.clone(), seq, api_rx, event_sink.clone());

            // Optionally wrap the latest user message with the
            // IDE context block. We always work on a freshly cloned
            // vector so the persisted session stays clean (the
            // contract: `user_message` is verbatim in JSONL, the
            // API sees `<ide_context>…</ide_context>` ahead of it).
            let owned_messages: Option<Vec<ConversationMessage>> =
                match self.config.ide_context.as_deref().filter(|s| !s.is_empty()) {
                    Some(ctx) => Some(inject_ide_context(session.messages(), ctx)),
                    None => None,
                };
            let messages_for_api: &[ConversationMessage] = owned_messages
                .as_deref()
                .unwrap_or_else(|| session.messages());

            let request = ApiRequest {
                model: &model,
                system_prompt: self.config.system_prompt.as_deref(),
                messages: messages_for_api,
                tools: &tool_schemas,
                temperature: self.config.default_temperature,
                max_output_tokens: self.config.default_max_output_tokens,
                thinking_enabled: self.config.thinking_enabled,
            };

            let stream_result = self
                .api_client
                .stream(request, api_tx, cancel_token.clone())
                .await;

            // Drain the forwarder so we recover the final `seq`.
            seq = match forwarder.await {
                Ok(final_seq) => final_seq,
                Err(join_err) => {
                    return Err(RuntimeError::InvalidState(format!(
                        "event forwarder task failed: {join_err}"
                    )));
                }
            };

            let turn = match stream_result {
                Ok(t) => t,
                Err(api_err) => {
                    if api_err.is_recoverable() {
                        let envelope = AgentEventEnvelope {
                            turn_id: turn_id.clone(),
                            seq,
                            event: AssistantEvent::Error {
                                message: api_err.to_string(),
                                recoverable: true,
                            },
                        };
                        let _ = event_sink.send(envelope).await;
                    }
                    return Err(api_err.into());
                }
            };

            total_usage = sum_usage(total_usage, turn.usage);

            // Append the assistant message to the session and bookkeeping.
            session.append_message(turn.assistant_message.clone());
            assistant_messages.push(turn.assistant_message.clone());

            // ── Tool dispatch ──────────────────────────────────────
            let pending_tools = collect_tool_calls(&turn.assistant_message);

            if pending_tools.is_empty() {
                // No more tools — the turn is done. We don't need to
                // bump `seq` again; nothing reads it after the break.
                stop_reason = turn.stop_reason;
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::MessageStop {
                        stop_reason: stop_reason.clone(),
                    },
                };
                let _ = event_sink.send(envelope).await;
                break;
            }

            // Cancel check between API call and tool execution — a
            // cancel arriving here saves us up to N tool dispatches.
            if cancel_token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }

            let tool_msg = self
                .execute_tool_calls(
                    pending_tools,
                    session,
                    &turn_id,
                    &cancel_token,
                    &event_sink,
                    &mut seq,
                )
                .await?;
            session.append_message(tool_msg.clone());
            tool_results.push(tool_msg);

            // …loop back for the next assistant message.
        }

        Ok(TurnCompletion {
            turn_id,
            stop_reason,
            iterations,
            usage: total_usage,
            assistant_messages,
            tool_results,
        })
    }

    /// Execute one batch of tool calls (the `ToolUse` blocks emitted
    /// in a single assistant message), aggregate their results into
    /// one `MessageRole::Tool` message, and return it. The caller
    /// appends to the session.
    ///
    /// Each tool runs sequentially in this Phase 2.1 skeleton.
    /// Phase 4 will introduce parallel dispatch with a join policy
    /// keyed off tool risk level.
    async fn execute_tool_calls(
        &self,
        calls: Vec<PendingToolCall>,
        session: &Session,
        turn_id: &str,
        cancel_token: &CancellationToken,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        seq: &mut u64,
    ) -> Result<ConversationMessage, RuntimeError> {
        let mut result_blocks = Vec::with_capacity(calls.len());

        for call in calls {
            let PendingToolCall { id, name, input } = call;
            let context = ToolContext {
                turn_id: turn_id.to_string(),
                tool_call_id: id.clone(),
                session_id: session.session_id.clone(),
                workspace_root: session
                    .workspace_root
                    .as_ref()
                    .map(std::path::PathBuf::from),
                cancel_token: cancel_token.clone(),
            };

            // Phase 4 pre-tool-use hook fires before lookup so audit
            // trails capture even tools that resolve to NotFound.
            self.hook.pre_tool_use(&name, &input).await;

            let tool = self.tools.get(&name);
            let uses_frontend_lifecycle = tool
                .as_ref()
                .is_some_and(|executor| executor.uses_frontend_lifecycle());

            if !uses_frontend_lifecycle {
                emit_native_tool_event(
                    event_sink,
                    turn_id,
                    seq,
                    AssistantEvent::ToolExecutionStart {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    },
                )
                .await;
            }

            // The permission gate is wired into the registry: any tool
            // whose `requires_permission()` returns `true` was wrapped
            // by `install_permission_gate` in `lib.rs::setup` with a
            // `PermissionGuardedExecutor` that consults the permitter
            // chain before dispatching. So a plain `tool.execute(...)`
            // here transparently goes through the gate.
            //
            // Note: we emit `ToolExecutionStart` *before* the gate runs,
            // which means a card waiting on approval shows "executing"
            // in its base state. The chat UI's inline approve/deny
            // card overrides that visual state by gating purely on
            // `pendingApproval.id === tool.id` — see ToolTimeline's
            // `isAwaitingApproval` predicate.
            let outcome = match tool {
                Some(tool) => tool.execute(input.clone(), &context).await,
                None => Err(ToolError::NotFound(name.clone())),
            };

            // Phase 4 post-tool-use hook fires regardless of success
            // or failure, mirroring Anthropic CC's lifecycle. Borrow
            // through ToolHookResult so the success payload doesn't
            // need to be cloned just to satisfy the hook surface.
            let hook_result = match &outcome {
                Ok(s) => ToolHookResult::Success(s.as_str()),
                Err(e) => ToolHookResult::Error(e),
            };
            self.hook.post_tool_use(&name, hook_result).await;

            // A cancellation during a tool propagates immediately.
            if matches!(&outcome, Err(ToolError::Cancelled)) {
                return Err(RuntimeError::Cancelled);
            }

            let (content, is_error) = match outcome {
                Ok(s) => (s, None),
                Err(e) => (e.to_string(), Some(true)),
            };

            if !uses_frontend_lifecycle {
                emit_native_tool_event(
                    event_sink,
                    turn_id,
                    seq,
                    AssistantEvent::ToolExecutionResult {
                        id: id.clone(),
                        name,
                        input,
                        content: content.clone(),
                        is_error: is_error.unwrap_or(false),
                    },
                )
                .await;
            }

            result_blocks.push(ContentBlock::ToolResult {
                tool_use_id: id,
                content,
                is_error,
            });
        }

        Ok(ConversationMessage {
            role: MessageRole::Tool,
            blocks: result_blocks,
            usage: None,
            timestamp: Utc::now().timestamp_millis(),
        })
    }
}

/// One pending tool call extracted from an assistant message.
#[derive(Debug, Clone)]
struct PendingToolCall {
    id: String,
    name: String,
    input: serde_json::Value,
}

/// Clone the message list and prepend the IDE context block to the
/// **last** `MessageRole::User` message. The block is wrapped in
/// `<ide_context>…</ide_context>` to mirror Aurora's existing
/// TS behaviour. If no user message is found, or the user's first
/// block is not a `Text` block, the helper falls back to inserting a
/// fresh leading text block.
fn inject_ide_context(
    messages: &[ConversationMessage],
    ide_context: &str,
) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().rposition(|m| m.role == MessageRole::User) else {
        return owned;
    };
    let wrapped = format!("<ide_context>\n{ide_context}\n</ide_context>");
    match owned[idx].blocks.first_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{wrapped}\n\n{text}");
        }
        _ => {
            // First block is not text (or message has no blocks) —
            // insert the IDE context as a new leading text block so
            // the model still sees it.
            owned[idx]
                .blocks
                .insert(0, ContentBlock::Text { text: wrapped });
        }
    }
    owned
}

fn collect_tool_calls(message: &ConversationMessage) -> Vec<PendingToolCall> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => Some(PendingToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect()
}

async fn emit_native_tool_event(
    event_sink: &mpsc::Sender<AgentEventEnvelope>,
    turn_id: &str,
    seq: &mut u64,
    event: AssistantEvent,
) {
    let envelope = AgentEventEnvelope {
        turn_id: turn_id.to_string(),
        seq: *seq,
        event,
    };
    *seq = (*seq).saturating_add(1);
    let _ = event_sink.send(envelope).await;
}

fn sum_usage(a: TokenUsage, b: TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: a.input_tokens.saturating_add(b.input_tokens),
        output_tokens: a.output_tokens.saturating_add(b.output_tokens),
        cache_creation_input_tokens: sum_opt(
            a.cache_creation_input_tokens,
            b.cache_creation_input_tokens,
        ),
        cache_read_input_tokens: sum_opt(a.cache_read_input_tokens, b.cache_read_input_tokens),
    }
}

fn sum_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.saturating_add(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

fn generate_turn_id() -> String {
    // ULID would sort better, but we don't carry that crate yet —
    // UUIDv4 is good enough for Phase 2.1 since `seq` already gives
    // intra-turn ordering.
    Uuid::new_v4().to_string()
}

/// Spawn a task that drains `api_rx` into `event_sink`, wrapping
/// each [`AssistantEvent`] in an [`AgentEventEnvelope`] with a
/// monotonic sequence number that starts at `start_seq`. Returns a
/// `JoinHandle<u64>` whose final `u64` is the next sequence number to
/// hand back to the runtime.
fn spawn_event_forwarder(
    turn_id: String,
    start_seq: u64,
    mut api_rx: mpsc::Receiver<AssistantEvent>,
    event_sink: mpsc::Sender<AgentEventEnvelope>,
) -> tokio::task::JoinHandle<u64> {
    tokio::spawn(async move {
        let mut seq = start_seq;
        while let Some(event) = api_rx.recv().await {
            let envelope = AgentEventEnvelope {
                turn_id: turn_id.clone(),
                seq,
                event,
            };
            seq = seq.saturating_add(1);
            if event_sink.send(envelope).await.is_err() {
                // Caller dropped the receiver — stop forwarding.
                break;
            }
        }
        seq
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::{ApiError, TurnUsage};
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    // ── Test doubles ────────────────────────────────────────────────

    /// Mock API client that emits a scripted sequence of events and
    /// then returns a canned `TurnUsage`. Each call advances through
    /// the script; if the script runs out the test fails.
    struct MockApi {
        script: Mutex<Vec<TurnScript>>,
    }

    struct TurnScript {
        events: Vec<AssistantEvent>,
        result: Result<TurnUsage, ApiError>,
    }

    impl MockApi {
        fn new(turns: Vec<TurnScript>) -> Self {
            Self {
                script: Mutex::new(turns),
            }
        }
    }

    #[async_trait]
    impl StreamingApiClient for MockApi {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let turn = {
                let mut script = self.script.lock().expect("script mutex");
                if script.is_empty() {
                    return Err(ApiError::Provider(
                        "MockApi script exhausted — test bug".into(),
                    ));
                }
                script.remove(0)
            };
            for event in turn.events {
                if event_sink.send(event).await.is_err() {
                    return Err(ApiError::Network("event sink closed".into()));
                }
            }
            turn.result
        }
    }

    /// Tool that records every input it sees and returns a canned
    /// string. Used to verify the runtime's tool dispatch path.
    struct RecordingTool {
        name: &'static str,
        seen: Arc<Mutex<Vec<serde_json::Value>>>,
        response: String,
    }

    #[async_trait]
    impl super::super::tool_executor::ToolExecutor for RecordingTool {
        fn name(&self) -> &str {
            self.name
        }
        fn schema(&self) -> super::super::api_client::ToolSchema {
            super::super::api_client::ToolSchema {
                name: self.name.into(),
                description: "test recorder".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }
        }
        async fn execute(
            &self,
            input: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            self.seen.lock().expect("seen mutex").push(input);
            Ok(self.response.clone())
        }
    }

    fn assistant_text(text: &str) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![ContentBlock::Text { text: text.into() }],
            1_700_000_000_000,
        )
    }

    fn assistant_tool_use(id: &str, name: &str, input: serde_json::Value) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input,
            }],
            1_700_000_000_000,
        )
    }

    fn turn_usage(message: ConversationMessage, stop_reason: &str) -> TurnUsage {
        TurnUsage {
            usage: TokenUsage {
                input_tokens: 5,
                output_tokens: 7,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
            },
            stop_reason: stop_reason.into(),
            assistant_message: message,
        }
    }

    fn user_msg(text: &str) -> ConversationMessage {
        ConversationMessage::user_text(text, 1_700_000_000_000)
    }

    // ── Tests ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn run_turn_no_tools_returns_after_one_iteration() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![
                AssistantEvent::TextDelta {
                    delta: "hello".into(),
                },
                AssistantEvent::TextDelta {
                    delta: " world".into(),
                },
            ],
            result: Ok(turn_usage(assistant_text("hello world"), "end_turn")),
        }]));
        let tools = Arc::new(ToolRegistry::new());
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, mut rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let summary = runtime
            .run_turn(&mut session, user_msg("hi"), tx, cancel)
            .await
            .expect("ok");

        assert_eq!(summary.iterations, 1);
        assert_eq!(summary.stop_reason, "end_turn");
        assert_eq!(summary.assistant_messages.len(), 1);
        assert!(summary.tool_results.is_empty());
        assert_eq!(summary.usage.input_tokens, 5);
        assert_eq!(summary.usage.output_tokens, 7);

        // session has user + assistant
        assert_eq!(session.len(), 2);

        // Drain the event channel and confirm we got 3 events:
        // 2 deltas + 1 message_stop, with strictly increasing seq.
        let mut events = Vec::new();
        while let Ok(envelope) =
            tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
        {
            match envelope {
                Some(e) => events.push(e),
                None => break,
            }
        }
        assert_eq!(events.len(), 3, "expected 3 events, got {events:?}");
        for window in events.windows(2) {
            assert!(
                window[1].seq > window[0].seq,
                "seq must be strictly monotonic"
            );
            assert_eq!(window[0].turn_id, window[1].turn_id);
        }
        match &events[2].event {
            AssistantEvent::MessageStop { stop_reason } => {
                assert_eq!(stop_reason, "end_turn")
            }
            other => panic!("expected MessageStop last, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_dispatches_tool_then_loops_for_final_text() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![AssistantEvent::ToolUse {
                    id: "call-1".into(),
                    name: "echo".into(),
                    input: serde_json::json!({"msg": "hi"}),
                }],
                result: Ok(turn_usage(
                    assistant_tool_use("call-1", "echo", serde_json::json!({"msg": "hi"})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![AssistantEvent::TextDelta {
                    delta: "done".into(),
                }],
                result: Ok(turn_usage(assistant_text("done"), "end_turn")),
            },
        ]));

        let tools = Arc::new(ToolRegistry::new());
        let seen = Arc::new(Mutex::new(Vec::new()));
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "hi".into(),
        }));

        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
        let mut session = Session::new("t");
        let (tx, mut rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let summary = runtime
            .run_turn(&mut session, user_msg("hi"), tx, cancel)
            .await
            .expect("ok");

        assert_eq!(summary.iterations, 2, "should loop once for the tool");
        assert_eq!(summary.tool_results.len(), 1);
        assert_eq!(summary.assistant_messages.len(), 2);
        assert_eq!(summary.stop_reason, "end_turn");

        // session = user + assistant(tool_use) + tool(result) + assistant(text)
        assert_eq!(session.len(), 4);

        let recorded = seen.lock().expect("seen mutex");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0], serde_json::json!({"msg": "hi"}));

        // The tool_results message must contain a ToolResult block
        // referencing the call id.
        match &summary.tool_results[0].blocks[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "call-1");
                assert_eq!(content, "hi");
                assert!(is_error.is_none(), "successful tool result has no is_error");
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }

        let mut events = Vec::new();
        while let Ok(envelope) =
            tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
        {
            match envelope {
                Some(e) => events.push(e),
                None => break,
            }
        }
        assert_eq!(
            events.len(),
            5,
            "expected full tool lifecycle, got {events:?}"
        );
        assert!(matches!(
            &events[0].event,
            AssistantEvent::ToolUse { id, name, .. }
                if id == "call-1" && name == "echo"
        ));
        match &events[1].event {
            AssistantEvent::ToolExecutionStart { id, name, input } => {
                assert_eq!(id, "call-1");
                assert_eq!(name, "echo");
                assert_eq!(input, &serde_json::json!({"msg":"hi"}));
            }
            other => panic!("expected ToolExecutionStart, got {other:?}"),
        }
        match &events[2].event {
            AssistantEvent::ToolExecutionResult {
                id,
                name,
                content,
                is_error,
                ..
            } => {
                assert_eq!(id, "call-1");
                assert_eq!(name, "echo");
                assert_eq!(content, "hi");
                assert!(!is_error);
            }
            other => panic!("expected ToolExecutionResult, got {other:?}"),
        }
        match &events[4].event {
            AssistantEvent::MessageStop { stop_reason } => assert_eq!(stop_reason, "end_turn"),
            other => panic!("expected MessageStop last, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_returns_tool_result_with_is_error_when_tool_not_found() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("call-x", "nonexistent", serde_json::json!({})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
            },
        ]));
        let tools = Arc::new(ToolRegistry::new());
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let summary = runtime
            .run_turn(&mut session, user_msg("?"), tx, cancel)
            .await
            .expect("ok");

        assert_eq!(summary.tool_results.len(), 1);
        match &summary.tool_results[0].blocks[0] {
            ContentBlock::ToolResult {
                content, is_error, ..
            } => {
                assert_eq!(*is_error, Some(true));
                assert!(content.contains("tool not found"));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_respects_max_iterations_cap() {
        // Script always asks for another tool — would loop forever
        // without the cap.
        let always_tool = TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                "tool_use",
            )),
        };
        // Need at least 4 entries so the cap-of-3 hits the limit
        // before exhausting the script.
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("call-loop", "echo", serde_json::json!({"msg":"loop"})),
                    "tool_use",
                )),
            },
            always_tool,
        ]));

        let tools = Arc::new(ToolRegistry::new());
        let seen = Arc::new(Mutex::new(Vec::new()));
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "loop".into(),
        }));

        let runtime = ConversationRuntime::new(
            api,
            tools,
            RuntimeConfig {
                max_iterations: Some(3),
                ..RuntimeConfig::default()
            },
        );

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let err = runtime
            .run_turn(&mut session, user_msg("?"), tx, cancel)
            .await
            .expect_err("must hit cap");
        match err {
            RuntimeError::InvalidState(msg) => {
                assert!(
                    msg.contains("max_iterations"),
                    "must mention cap, got: {msg}"
                );
            }
            other => panic!("expected InvalidState, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_returns_cancelled_when_pre_cancelled() {
        let api = Arc::new(MockApi::new(vec![]));
        let tools = Arc::new(ToolRegistry::new());
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        cancel.cancel();

        let err = runtime
            .run_turn(&mut session, user_msg("?"), tx, cancel)
            .await
            .expect_err("must cancel");
        assert!(err.is_cancellation());
    }

    #[tokio::test]
    async fn run_turn_aggregates_usage_across_iterations() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(TurnUsage {
                    usage: TokenUsage {
                        input_tokens: 10,
                        output_tokens: 20,
                        cache_creation_input_tokens: Some(3),
                        cache_read_input_tokens: None,
                    },
                    stop_reason: "tool_use".into(),
                    assistant_message: assistant_tool_use(
                        "c1",
                        "echo",
                        serde_json::json!({"msg":"x"}),
                    ),
                }),
            },
            TurnScript {
                events: vec![],
                result: Ok(TurnUsage {
                    usage: TokenUsage {
                        input_tokens: 5,
                        output_tokens: 8,
                        cache_creation_input_tokens: Some(1),
                        cache_read_input_tokens: Some(2),
                    },
                    stop_reason: "end_turn".into(),
                    assistant_message: assistant_text("done"),
                }),
            },
        ]));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: Arc::new(Mutex::new(Vec::new())),
            response: "ok".into(),
        }));
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let summary = runtime
            .run_turn(&mut session, user_msg("hi"), tx, cancel)
            .await
            .expect("ok");

        assert_eq!(summary.usage.input_tokens, 15);
        assert_eq!(summary.usage.output_tokens, 28);
        assert_eq!(summary.usage.cache_creation_input_tokens, Some(4));
        assert_eq!(summary.usage.cache_read_input_tokens, Some(2));
    }

    /// Mock that captures the `ApiRequest` it was called with so a
    /// test can assert the runtime forwarded the right per-turn
    /// overrides into the wire-level request.
    struct CapturingApi {
        captured: Arc<Mutex<Option<CapturedRequest>>>,
    }

    /// `ApiRequest<'a>` is borrowed; copy the fields we want to
    /// inspect into an owned snapshot so we can read it after the
    /// future returns.
    #[derive(Debug, Clone)]
    struct CapturedRequest {
        system_prompt: Option<String>,
        temperature: Option<f32>,
        max_output_tokens: u32,
        thinking_enabled: bool,
        model: String,
    }

    #[async_trait]
    impl StreamingApiClient for CapturingApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            *self.captured.lock().expect("captured mutex") = Some(CapturedRequest {
                system_prompt: request.system_prompt.map(str::to_string),
                temperature: request.temperature,
                max_output_tokens: request.max_output_tokens,
                thinking_enabled: request.thinking_enabled,
                model: request.model.to_string(),
            });
            Ok(turn_usage(assistant_text("ok"), "end_turn"))
        }
    }

    #[tokio::test]
    async fn run_turn_forwards_runtime_config_temperature_into_api_request() {
        // Phase 2.3: per-turn overrides flow through `RuntimeConfig`
        // into `ApiRequest::temperature`.
        let captured = Arc::new(Mutex::new(None));
        let api = Arc::new(CapturingApi {
            captured: captured.clone(),
        });
        let runtime = ConversationRuntime::new(
            api,
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                default_temperature: Some(0.42),
                ..RuntimeConfig::default()
            },
        );

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = captured.lock().expect("captured mutex");
        let captured = captured.as_ref().expect("api was called");
        assert_eq!(captured.temperature, Some(0.42));
    }

    #[tokio::test]
    async fn run_turn_forwards_system_prompt_max_tokens_thinking_into_api_request() {
        let captured = Arc::new(Mutex::new(None));
        let api = Arc::new(CapturingApi {
            captured: captured.clone(),
        });
        let runtime = ConversationRuntime::new(
            api,
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                system_prompt: Some("YOU ARE THE AURORA SYSTEM PROMPT".into()),
                default_max_output_tokens: 1234,
                thinking_enabled: true,
                default_temperature: Some(0.0),
                ..RuntimeConfig::default()
            },
        );

        let mut session = Session::new("t");
        session.model = Some("claude-3-7-sonnet".into());
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = captured.lock().expect("captured mutex");
        let captured = captured.as_ref().expect("api was called");
        assert_eq!(
            captured.system_prompt.as_deref(),
            Some("YOU ARE THE AURORA SYSTEM PROMPT")
        );
        assert_eq!(captured.max_output_tokens, 1234);
        assert!(captured.thinking_enabled);
        assert_eq!(captured.temperature, Some(0.0));
        assert_eq!(captured.model, "claude-3-7-sonnet");
    }

    /// Mock that captures the messages slice the runtime hands to
    /// the API client. Used to verify ide_context wrapping.
    struct CapturingMessagesApi {
        captured: Arc<Mutex<Option<Vec<ConversationMessage>>>>,
    }

    #[async_trait]
    impl StreamingApiClient for CapturingMessagesApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            *self.captured.lock().expect("captured mutex") = Some(request.messages.to_vec());
            Ok(turn_usage(assistant_text("ok"), "end_turn"))
        }
    }

    #[tokio::test]
    async fn run_turn_wraps_user_message_with_ide_context_for_api_only() {
        let captured = Arc::new(Mutex::new(None));
        let api = Arc::new(CapturingMessagesApi {
            captured: captured.clone(),
        });
        let runtime = ConversationRuntime::new(
            api,
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                ide_context: Some("OPEN_FILE: src/main.rs".into()),
                ..RuntimeConfig::default()
            },
        );

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(
                &mut session,
                user_msg("hello, agent"),
                tx,
                CancellationToken::new(),
            )
            .await
            .expect("ok");

        // API saw the user message wrapped with the ide_context block.
        let captured = captured.lock().expect("captured mutex");
        let captured = captured.as_ref().expect("api was called");
        let api_user = captured
            .iter()
            .find(|m| m.role == MessageRole::User)
            .expect("api saw a user message");
        match &api_user.blocks[0] {
            ContentBlock::Text { text } => {
                assert!(
                    text.contains("<ide_context>"),
                    "API user must include ide_context wrapper, got: {text}"
                );
                assert!(
                    text.contains("OPEN_FILE: src/main.rs"),
                    "API user must include ide_context body, got: {text}"
                );
                assert!(
                    text.contains("hello, agent"),
                    "API user must still include the original message, got: {text}"
                );
            }
            other => panic!("expected Text, got {other:?}"),
        }

        // Persisted session keeps the user message clean.
        let session_user = session
            .messages()
            .iter()
            .find(|m| m.role == MessageRole::User)
            .expect("session has user");
        match &session_user.blocks[0] {
            ContentBlock::Text { text } => {
                assert_eq!(
                    text, "hello, agent",
                    "session JSONL must remain verbatim — got: {text}"
                );
                assert!(
                    !text.contains("ide_context"),
                    "session must NOT contain the ide_context wrapper, got: {text}"
                );
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_skips_ide_context_when_empty() {
        let captured = Arc::new(Mutex::new(None));
        let api = Arc::new(CapturingMessagesApi {
            captured: captured.clone(),
        });
        let runtime = ConversationRuntime::new(
            api,
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                ide_context: Some(String::new()),
                ..RuntimeConfig::default()
            },
        );

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = captured.lock().expect("captured mutex");
        let captured = captured.as_ref().expect("api was called");
        match &captured[0].blocks[0] {
            ContentBlock::Text { text } => {
                assert!(
                    !text.contains("ide_context"),
                    "empty ide_context must NOT wrap, got: {text}"
                );
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_default_config_yields_none_temperature_and_no_thinking() {
        // Sanity-check the default — `None` temperature and
        // `thinking_enabled: false` make the runtime defer to the
        // provider preset.
        let captured = Arc::new(Mutex::new(None));
        let api = Arc::new(CapturingApi {
            captured: captured.clone(),
        });
        let runtime =
            ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = captured.lock().expect("captured mutex");
        let captured = captured.as_ref().expect("api was called");
        assert_eq!(captured.temperature, None);
        assert!(!captured.thinking_enabled);
        assert_eq!(captured.max_output_tokens, 8192);
        assert!(captured.system_prompt.is_none());
    }

    /// Hook recorder that captures every pre/post callback in order.
    /// Used by the integration tests below to verify the runtime fires
    /// hooks around tool dispatch in the contract-mandated order.
    #[derive(Default)]
    struct RecordingHook {
        events: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl super::super::hooks::Hook for RecordingHook {
        async fn pre_tool_use(&self, name: &str, _input: &serde_json::Value) {
            self.events
                .lock()
                .expect("events")
                .push(format!("pre:{name}"));
        }

        async fn post_tool_use(&self, name: &str, result: super::super::hooks::ToolHookResult<'_>) {
            let tag = match result {
                super::super::hooks::ToolHookResult::Success(s) => format!("ok:{s}"),
                super::super::hooks::ToolHookResult::Error(e) => format!("err:{e}"),
            };
            self.events
                .lock()
                .expect("events")
                .push(format!("post:{name}:{tag}"));
        }
    }

    #[tokio::test]
    async fn run_turn_fires_pre_then_post_hook_around_tool_dispatch() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("c1", "echo", serde_json::json!({"msg":"hi"})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(assistant_text("done"), "end_turn")),
            },
        ]));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: Arc::new(Mutex::new(Vec::new())),
            response: "hi".into(),
        }));

        let hook = Arc::new(RecordingHook::default());
        let runtime =
            ConversationRuntime::new(api, tools, RuntimeConfig::default()).with_hook(hook.clone());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let events = hook.events.lock().expect("events").clone();
        assert_eq!(events.len(), 2, "expected 1 pre + 1 post, got {events:?}");
        assert_eq!(events[0], "pre:echo");
        assert_eq!(events[1], "post:echo:ok:hi");
    }

    #[tokio::test]
    async fn run_turn_post_hook_fires_with_error_when_tool_not_found() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("cx", "missing_tool", serde_json::json!({})),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
            },
        ]));
        let tools = Arc::new(ToolRegistry::new());
        let hook = Arc::new(RecordingHook::default());
        let runtime =
            ConversationRuntime::new(api, tools, RuntimeConfig::default()).with_hook(hook.clone());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("?"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let events = hook.events.lock().expect("events").clone();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], "pre:missing_tool");
        assert!(
            events[1].starts_with("post:missing_tool:err:tool not found"),
            "got: {}",
            events[1]
        );
    }

    #[tokio::test]
    async fn run_turn_default_no_hook_still_compiles_and_runs() {
        // Sanity: the additive wiring keeps existing behaviour for
        // any caller that doesn't invoke `.with_hook(...)`.
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
        }]));
        let runtime =
            ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());
        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");
    }

    #[tokio::test]
    async fn run_turn_propagates_recoverable_api_error_with_event() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Err(ApiError::RateLimit),
        }]));
        let tools = Arc::new(ToolRegistry::new());
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, mut rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();

        let err = runtime
            .run_turn(&mut session, user_msg("?"), tx, cancel)
            .await
            .expect_err("must surface api err");
        match err {
            RuntimeError::Api(ApiError::RateLimit) => {}
            other => panic!("expected Api(RateLimit), got {other:?}"),
        }

        let envelope = tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv())
            .await
            .expect("event timeout")
            .expect("event present");
        match envelope.event {
            AssistantEvent::Error {
                message,
                recoverable,
            } => {
                assert!(recoverable, "rate-limit must be recoverable");
                assert!(message.contains("rate"), "got message: {message}");
            }
            other => panic!("expected Error event, got {other:?}"),
        }
    }
}
