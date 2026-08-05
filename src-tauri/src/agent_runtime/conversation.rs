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
use super::session::{RichToolResult, Session};
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

    /// Explicit thinking token budget for models whose reasoning control
    /// is a budget rather than an effort tier. `None` lets the adapter
    /// derive one (Anthropic scales the effort tier against
    /// `default_max_output_tokens`). Only read when `thinking_enabled`.
    pub thinking_budget_tokens: Option<u32>,

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

    /// Provider's advertised context window for the chosen model.
    /// `None` disables budget-aware trimming entirely (legacy
    /// behaviour: send the whole session every iteration).
    ///
    /// When `Some(window)`, the runtime trims older messages from the
    /// API view before each call so the request stays under
    /// ~75% of `window - default_max_output_tokens * 1.1`. The
    /// persisted JSONL is untouched — trim is purely an API-view
    /// concern, mirroring how `ide_context` injection works.
    pub context_window: Option<u32>,

    /// Compaction trigger as a fraction of `context_window` (e.g. `0.80`).
    /// When the projected next-request size crosses this, the runtime
    /// summarizes older history into a persistent marker before continuing
    /// (see `DOCS/compaction-design.md`). `None` or `<= 0` disables
    /// compaction entirely — the request then relies on `trim` alone.
    /// Has no effect when `context_window` is `None`.
    pub compaction_threshold: Option<f32>,

    /// `max_output_tokens` budget for the summarization call. Larger = a
    /// richer, higher-fidelity summary. Clamped by the caller (2k–16k).
    pub compaction_summary_budget: u32,

    /// When true, read-only file tools may resolve paths OUTSIDE the workspace
    /// (user opt-in via Settings → Agent). Writes stay workspace-bound.
    pub allow_outside_workspace: bool,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            max_iterations: None,
            system_prompt: None,
            // Reasoning tokens bill against the output cap on every provider
            // except Anthropic (whose budget is added on top — see
            // `anthropic_max_tokens_with_thinking`). At 8k a high reasoning
            // effort could consume the entire allowance before the model wrote
            // a word, ending the turn at the cap with nothing to show. The
            // extra headroom costs ~9k of trim reserve on a 200k window.
            default_max_output_tokens: 16_384,
            thinking_enabled: false,
            thinking_budget_tokens: None,
            default_temperature: None,
            ide_context: None,
            context_window: None,
            compaction_threshold: None,
            compaction_summary_budget: 8192,
            allow_outside_workspace: false,
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
    /// Session-store root, used to place spilled tool output beside the
    /// thread it belongs to. `None` disables spilling — results are then
    /// clamped as before, which is what tests and non-persisting callers get.
    store_dir: Option<std::path::PathBuf>,
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
            store_dir: None,
        }
    }

    /// Point the runtime at the session store's directory so oversized tool
    /// output can be spilled to a file the model can read back, instead of
    /// being clamped away. See [`super::tool_spill`].
    #[must_use]
    pub fn with_store_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    /// Move oversized payloads in `raw` onto disk, returning the content with
    /// a head+tail preview and the file's path. A no-op without a store dir.
    fn spill_tool_output(&self, session: &Session, tool_call_id: &str, raw: String) -> String {
        let Some(root) = self.store_dir.as_deref() else {
            return raw;
        };
        let dir = super::session_store::tool_results_dir_in(root, &session.thread_id);
        super::tool_spill::spill_oversized(&dir, tool_call_id, raw)
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

            // ── Context compaction ─────────────────────────────────
            // Before every model call, if the projected request crosses
            // the configured threshold, summarize older history into a
            // persistent marker (see `DOCS/compaction-design.md`). Runs
            // ahead of `trim` (the last-resort net) and shrinks the
            // model's working set across turns. Best-effort: any failure
            // leaves the session untouched and the turn proceeds.
            self.maybe_compact(session, &turn_id, &mut seq, &event_sink, &cancel_token)
                .await;

            // ── Stream one assistant message ───────────────────────
            let model = session.model.clone().unwrap_or_default();
            let tool_schemas = self.tools.schemas();

            // Internal event channel: API impl pushes `AssistantEvent`
            // onto `api_tx`; a forwarder task wraps each in an
            // envelope and pushes it onto the caller's sink.
            let (api_tx, api_rx) = mpsc::channel::<AssistantEvent>(64);

            let forwarder = spawn_event_forwarder(turn_id.clone(), seq, api_rx, event_sink.clone());

            // Apply any persisted compaction first: replace everything at
            // or older than the last compaction marker with its summary,
            // keeping the verbatim tail. The persisted JSONL keeps the full
            // history (the UI shows it); only this API view shrinks — the
            // same contract `inject_ide_context`/`trim` follow. A no-marker
            // session round-trips unchanged.
            let compacted = apply_compaction(session.messages());

            // Optionally wrap the latest user message with the
            // IDE context block. We always work on a freshly cloned
            // vector so the persisted session stays clean (the
            // contract: `user_message` is verbatim in JSONL, the
            // API sees `<ide_context>…</ide_context>` ahead of it).
            let owned_messages: Option<Vec<ConversationMessage>> =
                match self.config.ide_context.as_deref().filter(|s| !s.is_empty()) {
                    Some(ctx) => Some(inject_ide_context(&compacted, ctx)),
                    None => None,
                };

            // Budget-aware trim. Same API-view-only contract as
            // `inject_ide_context`: persisted session stays whole, only
            // the request body shrinks. Disabled (no-op) when
            // `context_window` is `None`.
            let trim_input: Vec<ConversationMessage> = owned_messages.unwrap_or(compacted);
            let trim_outcome = trim_to_budget(
                trim_input,
                self.config.context_window,
                self.config.default_max_output_tokens,
                self.config.system_prompt.as_deref().unwrap_or(""),
            );
            let messages_for_api: &[ConversationMessage] = &trim_outcome.messages;

            // When the trim dropped messages, append a small notice to
            // the system prompt so the model knows the early conversation
            // has been omitted (and won't hallucinate having seen it).
            // The original `config.system_prompt` is left untouched.
            let trim_notice: String;
            let system_prompt: Option<&str> = if trim_outcome.dropped > 0 {
                trim_notice = build_trim_notice(
                    self.config.system_prompt.as_deref().unwrap_or(""),
                    trim_outcome.dropped,
                );
                Some(trim_notice.as_str())
            } else {
                self.config.system_prompt.as_deref()
            };

            let request = ApiRequest {
                model: &model,
                system_prompt,
                messages: messages_for_api,
                tools: &tool_schemas,
                temperature: self.config.default_temperature,
                max_output_tokens: self.config.default_max_output_tokens,
                thinking_enabled: self.config.thinking_enabled,
                thinking_budget_tokens: self.config.thinking_budget_tokens,
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

            // No-usage providers (Fireworks/kimi, Ollama, custom) report zero
            // tokens. The frontend's fallback estimator then counts the FULL UI
            // transcript — which deliberately keeps every message — so it can't
            // see compaction and the context ring stays high even after we
            // shrank the real request. Emit a synthetic Usage carrying the
            // tiktoken count of what we ACTUALLY sent (post compaction + trim),
            // so the ring reflects the true, compacted context size.
            let mut effective_usage = turn.usage;
            if effective_usage.input_tokens == 0 && effective_usage.output_tokens == 0 {
                let tools_tokens = tool_schemas
                    .iter()
                    .map(|t| {
                        estimate_text_tokens(&t.name)
                            .saturating_add(estimate_text_tokens(&t.description))
                            .saturating_add(estimate_text_tokens(&t.input_schema.to_string()))
                    })
                    .fold(0u32, u32::saturating_add);
                let input = messages_for_api
                    .iter()
                    .map(estimate_message_tokens)
                    .fold(
                        estimate_text_tokens(system_prompt.unwrap_or("")),
                        u32::saturating_add,
                    )
                    .saturating_add(tools_tokens);
                let output = estimate_message_tokens(&turn.assistant_message);
                effective_usage = TokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                };
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::Usage(effective_usage.clone()),
                };
                seq = seq.saturating_add(1);
                let _ = event_sink.send(envelope).await;
            }

            total_usage = sum_usage(total_usage, effective_usage);

            // Append the assistant message to the session and bookkeeping.
            session.append_message(turn.assistant_message.clone());
            assistant_messages.push(turn.assistant_message.clone());

            // ── Tool dispatch ──────────────────────────────────────
            let pending_tools = collect_tool_calls(&turn.assistant_message);

            if pending_tools.is_empty() {
                // No more tools — the turn is done. We don't need to
                // bump `seq` again; nothing reads it after the break.
                stop_reason = turn.stop_reason;

                // A reply with no tool call and nothing to say is not a
                // finished turn. The usual cause is an in-band provider
                // error (see `OpenAiStreamingResponse::error`), which the
                // adapters now surface before we ever get here — this is the
                // backstop for a provider that closes cleanly having emitted
                // nothing at all. Say so; ending silently is what made this
                // class of failure impossible to diagnose.
                if !has_visible_answer(&turn.assistant_message) {
                    let notice = if has_thinking(&turn.assistant_message) {
                        "The model reasoned but never produced an answer, so this turn stopped \
                         early. Retry, or lower the reasoning effort for this model."
                    } else {
                        "The provider returned an empty reply — no text, no tool call, no error. \
                         Nothing was changed. Retry to run the turn again."
                    };
                    seq += 1;
                    let _ = event_sink
                        .send(AgentEventEnvelope {
                            turn_id: turn_id.clone(),
                            seq,
                            event: AssistantEvent::Error {
                                message: notice.to_string(),
                                recoverable: true,
                            },
                        })
                        .await;
                    let now = chrono::Utc::now().timestamp_millis();
                    session.append_message(ConversationMessage {
                        role: MessageRole::System,
                        blocks: vec![ContentBlock::Notice {
                            message: notice.to_string(),
                            created_at: now,
                        }],
                        usage: None,
                        timestamp: now,
                        attached_selected_elements: None,
                        attached_prompt_chips: None,
                    });
                }

                // `length` means the model was cut off mid-sentence by the
                // output cap, not that it finished. This used to end the
                // turn indistinguishably from a clean stop, so a truncated
                // answer looked like a complete one — the user's only clue
                // was prose that stopped mid-word. Say it out loud.
                if is_length_stop(&stop_reason) {
                    // Plain text: this renders in an inline notice marker, not
                    // through the markdown pipeline, so backticks would show up
                    // literally.
                    const TRUNCATED_NOTICE: &str =
                        "This reply is cut off — the model reached its output limit. Raise Max \
                         output for this model in provider settings, or ask it to continue.";
                    seq += 1;
                    let _ = event_sink
                        .send(AgentEventEnvelope {
                            turn_id: turn_id.clone(),
                            seq,
                            event: AssistantEvent::Error {
                                message: TRUNCATED_NOTICE.to_string(),
                                recoverable: true,
                            },
                        })
                        .await;
                    // Persist it too. The event alone only reaches the window
                    // that is open now; without a session record, reopening the
                    // thread shows the truncated reply with no explanation for
                    // why it stops mid-sentence. Appended AFTER the assistant
                    // message so it reloads directly beneath it.
                    let now = chrono::Utc::now().timestamp_millis();
                    session.append_message(ConversationMessage {
                        role: MessageRole::System,
                        blocks: vec![ContentBlock::Notice {
                            message: TRUNCATED_NOTICE.to_string(),
                            created_at: now,
                        }],
                        usage: None,
                        timestamp: now,
                        attached_selected_elements: None,
                        attached_prompt_chips: None,
                    });
                }

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

            let mut tool_msg = self
                .execute_tool_calls(
                    pending_tools,
                    session,
                    &turn_id,
                    &cancel_token,
                    &event_sink,
                    &mut seq,
                )
                .await?;

            // ── Mid-turn user message injection ─────────────────────
            //
            // If the user typed a new prompt while this turn was
            // streaming (`agent_enqueue_message` IPC), drain the slot
            // now and ride the queued text in on the next user message
            // by appending it as a Text block to the tool_msg we just
            // built. The provider adapters know to surface this:
            //
            //   - Anthropic: the Tool role maps to "role": "user" with
            //     a content array, so the tool_result blocks and the
            //     injected text block sit side-by-side in a single
            //     valid user message.
            //   - OpenAI-compat: the adapter splits Tool blocks into
            //     one `role: "tool"` message per tool_result plus a
            //     follow-up `role: "user"` for any text blocks (this
            //     is the patched behaviour added alongside the queue).
            //
            // Emit a dedicated event so the frontend can clear the
            // pending pill and append a visible user bubble in the
            // chat list — the model sees the merged user-role message
            // on the next API call, the human sees it as a normal
            // message in the timeline.
            if let Some(queued) = session.take_queued_message() {
                tool_msg.blocks.push(ContentBlock::Text {
                    text: queued.text.clone(),
                });
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::QueuedMessageInjected { text: queued.text },
                };
                seq = seq.saturating_add(1);
                let _ = event_sink.send(envelope).await;
            }

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

    /// Summarize older history into a persistent compaction marker when the
    /// projected request crosses the configured threshold. Best-effort: any
    /// disabled/too-short/failed case returns WITHOUT mutating the session,
    /// so the turn always proceeds (trim stays the last-resort net).
    /// See `DOCS/compaction-design.md`.
    async fn maybe_compact(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
    ) {
        let Some(threshold) = self.config.compaction_threshold else {
            return;
        };
        let Some(window) = self.config.context_window else {
            return;
        };
        if threshold <= 0.0 || window == 0 {
            return;
        }

        let system_prompt = self.config.system_prompt.as_deref().unwrap_or("");
        let system_tokens = estimate_text_tokens(system_prompt);

        // Projected size of the request we're about to build (after any prior
        // compaction is applied). Compare against threshold% of the window.
        let projected = apply_compaction(session.messages())
            .iter()
            .map(estimate_message_tokens)
            .fold(system_tokens, u32::saturating_add);
        let limit = (window as f32 * threshold) as u32;
        if projected < limit {
            return;
        }

        let _ = self
            .compact_now(session, turn_id, seq, event_sink, cancel_token)
            .await;
    }

    /// Force a compaction pass immediately, bypassing the configured threshold.
    /// Returns the before/after token estimate when a marker was persisted.
    pub async fn compact_now(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
    ) -> Option<(u32, u32)> {
        let Some(window) = self.config.context_window else {
            return None;
        };
        if window == 0 {
            return None;
        }

        let system_prompt = self.config.system_prompt.as_deref().unwrap_or("");
        let system_tokens = estimate_text_tokens(system_prompt);
        let projected = apply_compaction(session.messages())
            .iter()
            .map(estimate_message_tokens)
            .fold(system_tokens, u32::saturating_add);

        // A user-boundary cut preserving ~COMPACT_TAIL_PCT of the window
        // verbatim. `None` => transcript too short to compact safely.
        let cut = compaction_cut(session.messages(), window)?;

        // Signal the UI: ring → spinner, live shimmer card.
        emit_native_tool_event(event_sink, turn_id, seq, AssistantEvent::CompactionStarted).await;

        // Summarize the head (everything older than the cut). Any prior marker
        // in the head is folded to its summary first, so we never re-feed a
        // raw marker to the summarizer.
        let head_view = apply_compaction(&session.messages()[..cut]);
        let model = session.model.clone();
        let summary = self.summarize_head(&head_view, &model, cancel_token).await;

        let summary = match summary {
            Some(s) if !s.trim().is_empty() => s,
            _ => {
                // Failsafe: summary unavailable — leave history intact and
                // clear the indicator with a no-drop completion. Trim still
                // bounds the request body downstream.
                emit_native_tool_event(
                    event_sink,
                    turn_id,
                    seq,
                    AssistantEvent::CompactionCompleted {
                        before_tokens: projected,
                        after_tokens: projected,
                    },
                )
                .await;
                return None;
            }
        };

        // After-size = system + summary + the verbatim tail kept from `cut`.
        let tail_tokens = session.messages()[cut..]
            .iter()
            .map(estimate_message_tokens)
            .fold(0u32, u32::saturating_add);
        let after = system_tokens
            .saturating_add(estimate_text_tokens(&summary))
            .saturating_add(tail_tokens);

        let now = chrono::Utc::now().timestamp_millis();
        let marker = ConversationMessage {
            role: MessageRole::System,
            blocks: vec![ContentBlock::Compaction {
                summary,
                before_tokens: projected,
                after_tokens: after,
                created_at: now,
            }],
            usage: None,
            timestamp: now,
            attached_selected_elements: None,
            attached_prompt_chips: None,
        };
        // Insert at the boundary: `[head…][marker][tail…]`. The persisted
        // JSONL keeps the head (UI history); only the model API view drops it.
        session.messages.insert(cut, marker);

        emit_native_tool_event(
            event_sink,
            turn_id,
            seq,
            AssistantEvent::CompactionCompleted {
                before_tokens: projected,
                after_tokens: after,
            },
        )
        .await;

        Some((projected, after))
    }

    /// One-shot summarization call for [`Self::maybe_compact`]. Drains the
    /// event stream to void (the summary is never rendered) and returns the
    /// assistant text, or `None` on empty model / error / cancel. Uses the
    /// session's model, the dedicated compaction system prompt, and the
    /// configured output budget.
    async fn summarize_head(
        &self,
        head_view: &[ConversationMessage],
        model: &Option<String>,
        cancel_token: &CancellationToken,
    ) -> Option<String> {
        let model = model.clone().unwrap_or_default();
        if model.is_empty() {
            return None;
        }
        let mut messages = head_view.to_vec();
        messages.push(ConversationMessage {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text {
                text: COMPACTION_INSTRUCTION.to_string(),
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
        });

        let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

        let request = ApiRequest {
            model: &model,
            system_prompt: Some(COMPACTION_SYSTEM_PROMPT),
            messages: &messages,
            tools: &[],
            temperature: Some(0.3),
            max_output_tokens: self.config.compaction_summary_budget,
            thinking_enabled: false,
            // Summarization is a mechanical call — never spend the user's
            // reasoning budget on it.
            thinking_budget_tokens: None,
        };
        let result = self
            .api_client
            .stream(request, tx, cancel_token.clone())
            .await;
        let _ = drain.await;

        match result {
            Ok(turn) => Some(collect_assistant_text(&turn.assistant_message)),
            Err(_) => None,
        }
    }

    /// Execute one batch of tool calls (the `ToolUse` blocks emitted
    /// in a single assistant message), aggregate their results into
    /// one `MessageRole::Tool` message, and return it. The caller
    /// appends to the session.
    ///
    /// How many calls starting at `calls[0]` may run concurrently.
    ///
    /// Returns the length of the leading run of concurrency-safe calls, or
    /// `1` when the first call must run alone. Splitting on the first
    /// unsafe call (rather than partitioning the whole batch) preserves
    /// relative order between a read and a write the model deliberately
    /// sequenced — `[read a, read b, write a, read c]` runs `{a,b}`
    /// concurrently, then the write, then `c`.
    fn concurrent_batch_len(&self, calls: &[PendingToolCall]) -> usize {
        if calls.first().is_none_or(|call| !self.is_batchable(call)) {
            return 1;
        }
        calls
            .iter()
            .take_while(|call| self.is_batchable(call))
            .count()
    }

    /// Whether a call can share a batch with its neighbours.
    ///
    /// Calls that never reach an executor — malformed arguments, unknown
    /// tool names — are trivially safe: they produce an error string with
    /// no side effect at all.
    fn is_batchable(&self, call: &PendingToolCall) -> bool {
        if crate::api::provider_kernel_adapter::malformed_tool_input(&call.input).is_some() {
            return true;
        }
        self.tools
            .get(&call.name)
            .is_none_or(|tool| tool.concurrency_safe())
    }

    /// Independent read-only calls in the batch run **concurrently**;
    /// everything else stays strictly sequential and in order.
    ///
    /// Models routinely emit four to six independent reads in a single
    /// message. Running those one at a time made a step that should cost
    /// one round-trip cost six, which is most of why Aurora felt slow on a
    /// large repo. Concurrency is opt-in per executor via
    /// [`ToolExecutor::concurrency_safe`] (default `false`), so anything
    /// that mutates the workspace, prompts for permission, or drives the
    /// single shared browser panel keeps its ordering guarantees.
    ///
    /// Result blocks are always emitted in the model's original call order
    /// regardless of completion order.
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
        // Repeat-failure detector, scoped to this batch's turn. See
        // `FailureLoopGuard` — a model that re-issues an identical failing
        // call needs to be told so, or it will keep re-issuing it.
        let mut loop_guard = FailureLoopGuard::default();

        let mut cursor = 0usize;
        while cursor < calls.len() {
            let batch_len = self.concurrent_batch_len(&calls[cursor..]);
            let batch = &calls[cursor..cursor + batch_len];
            cursor += batch_len;

            // ── Announce ──────────────────────────────────────────────
            // Every start event fires before any execution begins, so a
            // concurrent batch lights up all its cards at once instead of
            // appearing to run one by one.
            let mut lifecycles = Vec::with_capacity(batch.len());
            for call in batch {
                // Phase 4 pre-tool-use hook fires before lookup so audit
                // trails capture even tools that resolve to NotFound.
                self.hook.pre_tool_use(&call.name, &call.input).await;

                let uses_frontend_lifecycle = self
                    .tools
                    .get(&call.name)
                    .is_some_and(|executor| executor.uses_frontend_lifecycle());
                lifecycles.push(uses_frontend_lifecycle);

                if !uses_frontend_lifecycle {
                    emit_native_tool_event(
                        event_sink,
                        turn_id,
                        seq,
                        AssistantEvent::ToolExecutionStart {
                            id: call.id.clone(),
                            name: call.name.clone(),
                            input: call.input.clone(),
                        },
                    )
                    .await;
                }
            }

            // ── Execute ───────────────────────────────────────────────
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
            let outcomes = futures_util::future::join_all(batch.iter().map(|call| {
                let context = ToolContext {
                    turn_id: turn_id.to_string(),
                    tool_call_id: call.id.clone(),
                    // The THREAD, never `session.session_id` — that is a fresh
                    // UUID per load. Tools key durable, per-conversation state
                    // off this (the todo list's sidecar, a plan step's run
                    // claim, background-process logs), so a session id meant the
                    // checklist was written to `<uuid>.todos.json`, announced to
                    // the UI under a thread id that did not exist, and lost on
                    // every restart.
                    thread_id: session.thread_id.clone(),
                    workspace_root: session
                        .workspace_root
                        .as_ref()
                        .map(std::path::PathBuf::from),
                    allow_outside_workspace: self.config.allow_outside_workspace,
                    cancel_token: cancel_token.clone(),
                };
                async move {
                    // Three distinct failures, three distinct messages.
                    // Collapsing any two of them is what makes a capable
                    // model look erratic: it retries, rephrases, and
                    // switches tools because the error it got back does
                    // not describe what it actually did.
                    match crate::api::provider_kernel_adapter::malformed_tool_input(&call.input) {
                        // The arguments never survived the stream. Do NOT
                        // dispatch: the executor would report a missing
                        // field to a model that sent it. Quote back what
                        // arrived so the model can see the truncation
                        // point and re-emit.
                        Some(raw) => Err(malformed_input_error(&call.name, raw)),
                        None => match self.tools.get(&call.name) {
                            Some(tool) => tool.execute(call.input.clone(), &context).await,
                            // Unknown name — hand back the nearest match and
                            // the real roster so this costs one iteration,
                            // not five.
                            None => Err(self.tools.unknown_tool_error(&call.name)),
                        },
                    }
                }
            }))
            .await;

            // ── Fold ──────────────────────────────────────────────────
            // Sequential and in call order: session spill, rich sidecars,
            // and result blocks all depend on a stable order.
            for ((call, outcome), uses_frontend_lifecycle) in
                batch.iter().zip(outcomes).zip(lifecycles)
            {
                let id = call.id.clone();
                let name = call.name.clone();
                let input = call.input.clone();

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

                let (raw_content, is_error) = match outcome {
                    Ok(s) => {
                        loop_guard.clear(&name, &input);
                        (s, None)
                    }
                    Err(e) => {
                        // Repeating an identical failing call is the most
                        // expensive thing a model can do here, and nothing used
                        // to interrupt it. Escalate the message itself so the
                        // second attempt reads differently from the first.
                        let mut message = e.to_string();
                        if let Some(note) = loop_guard.record_failure(&name, &input) {
                            message.push_str(&note);
                        }
                        (message, Some(true))
                    }
                };

                // Decouple the UI event payload from the model-history payload.
                // The 8 KiB clamp protects the conversation history / JSONL log /
                // API request body from megabyte-scale tool output, but ride-sharing
                // the same string with the UI event chops structured JSON results
                // (workspace_tree, grep, multi_file_read) mid-string. The frontend
                // then fails `JSON.parse` and falls back to dumping the raw
                // truncated bytes — that's the "sometimes tree, sometimes raw JSON"
                // artifact users see. Send the full payload to the UI; only the
                // history copy is truncated.
                //
                // The spill applies to the MODEL's copy only. Oversized output is
                // written to a file beside the thread and replaced with a head+tail
                // preview carrying that path — without it the clamp keeps only the
                // HEAD, which for a failing build is precisely the half that does
                // not contain the error, and the dropped bytes are unrecoverable
                // once the process has exited. The UI keeps the untouched payload
                // and applies its own display clamp, so a tool card never shows the
                // model's "read this file" instruction.
                let history_source = self.spill_tool_output(session, &id, raw_content.clone());
                let history_content = truncate_tool_content(&name, history_source);

                // Edit results whose history copy was clamped get a full-fidelity
                // sidecar copy (UI-shaped, so diffs render COMPLETE after a thread
                // reload). Stashed on the session; the persist path writes it to
                // `<thread_id>.rich.jsonl`. Model history stays clamped.
                if is_error.is_none() && rich_persisted_tool(&name) {
                    let ui_copy = truncate_tool_content_for_ui(&name, raw_content.clone());
                    if ui_copy != history_content {
                        session.push_rich_result(RichToolResult {
                            tool_use_id: id.clone(),
                            tool: name.clone(),
                            content: ui_copy,
                        });
                    }
                }

                if !uses_frontend_lifecycle {
                    let ui_content = truncate_tool_content_for_ui(&name, raw_content);
                    emit_native_tool_event(
                        event_sink,
                        turn_id,
                        seq,
                        AssistantEvent::ToolExecutionResult {
                            id: id.clone(),
                            name,
                            input,
                            content: ui_content,
                            is_error: is_error.unwrap_or(false),
                        },
                    )
                    .await;
                }

                result_blocks.push(ContentBlock::ToolResult {
                    tool_use_id: id,
                    content: history_content,
                    is_error,
                });
            }
        }

        Ok(ConversationMessage {
            role: MessageRole::Tool,
            blocks: result_blocks,
            usage: None,
            timestamp: Utc::now().timestamp_millis(),
            attached_selected_elements: None,
            attached_prompt_chips: None,
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

/// Whether a stop reason means "cut off by the output cap".
///
/// Providers disagree on the spelling: Anthropic says `max_tokens`, the
/// OpenAI family says `length`. Both mean the reply is incomplete.
fn is_length_stop(stop_reason: &str) -> bool {
    matches!(stop_reason, "length" | "max_tokens")
}

/// Did this assistant message actually say anything to the user?
///
/// Thinking blocks do NOT count. A reasoning model that spends its whole
/// output budget thinking and emits no answer has not replied — it has
/// stalled, and the turn ends looking identical to a completed one.
fn has_visible_answer(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        _ => false,
    })
}

/// Did the model produce reasoning but no answer?
///
/// Worth distinguishing, because the fix differs: reasoning-only means the
/// output cap or effort tier is wrong, while nothing-at-all points at the
/// provider or the route.
fn has_thinking(message: &ConversationMessage) -> bool {
    message
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Thinking { .. }))
}

/// Detects a model re-issuing a tool call that has already failed with the
/// exact same arguments, and escalates the error text when it does.
///
/// Nothing used to interrupt this. A `file_edit` whose `old_string` doesn't
/// match fails identically however many times it is retried, and because
/// each attempt returns the same message, the model has no signal that it is
/// repeating itself rather than making progress — so it burns the whole
/// iteration budget on one edit. The fix is not to block the call (a retry
/// after an intervening read is legitimate and often correct); it is to make
/// the second identical failure *read differently* from the first.
///
/// Scoped to a single batch of tool calls, keyed on `(tool, arguments)`.
/// A success clears the entry, so read → failed-edit → read → same-edit is
/// still treated as a repeat: only a successful call with those exact
/// arguments means the situation genuinely changed.
#[derive(Default)]
struct FailureLoopGuard {
    failures: std::collections::HashMap<(String, String), u32>,
}

impl FailureLoopGuard {
    fn key(tool: &str, input: &serde_json::Value) -> (String, String) {
        (tool.to_string(), input.to_string())
    }

    /// Record a failure and return the escalation to append, if any.
    fn record_failure(&mut self, tool: &str, input: &serde_json::Value) -> Option<String> {
        let count = self
            .failures
            .entry(Self::key(tool, input))
            .and_modify(|n| *n += 1)
            .or_insert(1);

        match *count {
            1 => None,
            2 => Some(format!(
                "\n\nNOTE: this is the SECOND time `{tool}` has been called with these exact \
                 arguments in this turn, and it failed identically both times. Repeating it \
                 will not produce a different result. Change something concrete first — re-read \
                 the file to get its current exact text, widen or narrow the match, or use a \
                 different tool."
            )),
            n => Some(format!(
                "\n\nSTOP: `{tool}` has now failed {n} times with these exact arguments. Do not \
                 issue this call again. Either take a different approach, or explain to the user \
                 what is blocking you and what you need from them."
            )),
        }
    }

    /// A call with these exact arguments succeeded — the state it depends
    /// on has genuinely changed, so a later failure starts counting fresh.
    fn clear(&mut self, tool: &str, input: &serde_json::Value) {
        self.failures.remove(&Self::key(tool, input));
    }
}

/// How much of an unparseable argument payload to quote back to the model.
/// Head and tail both, because the head shows which call it was and the
/// tail shows where it stopped — and for a truncated call the tail is the
/// only part that identifies the cause.
const MALFORMED_HEAD_CHARS: usize = 400;
const MALFORMED_TAIL_CHARS: usize = 200;

/// Build the error for a tool call whose arguments never parsed.
///
/// The goal is a message a model can act on in one step. That needs three
/// things the old `{}` substitution destroyed: that the call did **not**
/// run, what Aurora actually received, and which of the two causes it was.
/// A payload that ends mid-token was cut off by the output cap and should
/// be re-issued smaller; anything else is a syntax error the model can fix
/// in place.
fn malformed_input_error(tool: &str, raw: &str) -> ToolError {
    let char_count = raw.chars().count();
    let parse_error = serde_json::from_str::<serde_json::Value>(raw).err();
    let truncated = parse_error
        .as_ref()
        .is_some_and(|e| e.classify() == serde_json::error::Category::Eof);

    let detail = parse_error.map_or_else(
        || "the arguments parsed but were not a JSON object".to_string(),
        |e| e.to_string(),
    );

    let mut message = format!(
        "`{tool}` was NOT executed — its arguments did not parse as a JSON object.\n\
         Aurora received {char_count} characters; the parser reported: {detail}.\n\n"
    );

    if char_count <= MALFORMED_HEAD_CHARS + MALFORMED_TAIL_CHARS {
        message.push_str(&format!("Received verbatim:\n{raw}\n\n"));
    } else {
        let head: String = raw.chars().take(MALFORMED_HEAD_CHARS).collect();
        let tail: String = raw
            .chars()
            .skip(char_count - MALFORMED_TAIL_CHARS)
            .collect();
        message.push_str(&format!(
            "First {MALFORMED_HEAD_CHARS} characters:\n{head}\n\n\
             Last {MALFORMED_TAIL_CHARS} characters:\n{tail}\n\n"
        ));
    }

    message.push_str(if truncated {
        "The payload ends mid-value, so it was almost certainly cut off by the output-token \
         limit rather than written incorrectly. Re-issue this call with a smaller payload — \
         fewer edits per call, a narrower range, or several calls in sequence."
    } else {
        "Re-issue the call with valid JSON. Common causes: an unescaped backslash or quote \
         inside a string value, or a newline written literally instead of as `\\n`."
    });

    ToolError::MalformedInput(message)
}

/// Outcome of [`trim_to_budget`]: the (possibly shrunken) message list
/// the runtime should send to the API plus the count of messages that
/// were dropped from the head so the caller can build a user-facing
/// notice.
struct TrimOutcome {
    messages: Vec<ConversationMessage>,
    dropped: usize,
}

/// How much of the post-reserve budget we want to use before trimming
/// kicks in. 75% leaves headroom for the assistant's reply plus tool
/// results that arrive *during* the upcoming round.
const TRIM_THRESHOLD_PCT: u32 = 75;

/// Multiplier applied to `default_max_output_tokens` when reserving
/// space for the response. Models occasionally produce slightly more
/// than the requested cap; the 10% cushion keeps us out of the
/// 400-too-many-tokens window.
const OUTPUT_RESERVE_NUMER: u32 = 11;
const OUTPUT_RESERVE_DENOM: u32 = 10;

/// Number of trailing user-anchored turns the trim refuses to drop.
/// A "user-anchored turn" starts at a `MessageRole::User` message and
/// runs until the next `User` (or end of list). Keeping the last two
/// preserves the in-flight question + the immediately previous one
/// (often where the user gave context the model now needs).
const PRESERVE_LAST_USER_TURNS: usize = 2;

/// Hard cap on a single tool result before it enters the conversation
/// history, the API request body, and the streamed Tauri event payload.
/// Search-heavy tools (grep, multi_file_read, auroro_websearch fetch)
/// can otherwise return megabytes of text, which blows the model's
/// context window, bloats the JSONL log, and pressures the WebView2
/// IPC channel. Picked to match the legacy `context::manager` truncator
/// at four kilobytes, with extra slack for tools that return JSON
/// (whose formatting overhead burns characters without adding signal).
const MAX_TOOL_RESULT_LENGTH: usize = 8_192;

/// Model-history cap for content-delivery reads (`file_read`,
/// `multi_file_read`). These tools hand the model file content it must
/// match against VERBATIM to perform exact-text edits, and they already
/// bound their own output (file_read windows files over ~1500 lines /
/// 500 KB; multi_file_read caps per-file and in total). The generic 8 KiB
/// clamp was a SECOND, far tighter cap that silently hid the middle of any
/// file over ~200 lines — so a later file_edit built its `old_string` from
/// the invisible region and failed to match. A read-sized cap lets a normal
/// read through in full while still backstopping a pathological blob.
const MAX_READ_RESULT_LENGTH: usize = 512 * 1024;

/// Bytes held back from the clamp budget for the `[truncated …]` marker, so
/// the finished string still fits under its cap. The marker runs ~90 bytes
/// with realistic byte counts; 128 leaves headroom without being worth
/// computing exactly.
const TRUNCATION_MARKER_RESERVE: usize = 128;

/// Model-history cap for the workspace map.
///
/// `workspace_tree` self-limits by node budget (default 500 nodes at ~60 bytes
/// each), so it does not need a byte clamp to stay sane — it needs one only as
/// a backstop for an explicit `max_nodes` request. The generic 8 KiB cap was
/// far below what any useful map costs, which meant EVERY call went through
/// [`compact_json_arrays`]; that pass halves the largest array repeatedly, and
/// on Aurora's own repo it left 47 of 3,066 nodes with `src/` and `src-tauri/`
/// deleted outright and nothing in the payload admitting it. A clamp that
/// silently destroys the result it is meant to bound is worse than a bigger
/// clamp.
const MAX_TREE_RESULT_LENGTH: usize = 64 * 1024;

/// The model-history clamp for a given tool's result. Reads get the large
/// [`MAX_READ_RESULT_LENGTH`] (they self-limit and the model needs the
/// content); the workspace map gets [`MAX_TREE_RESULT_LENGTH`] for the same
/// reason; everything else keeps the tight [`MAX_TOOL_RESULT_LENGTH`] that
/// stops grep / websearch megabytes from flooding the context window.
fn result_cap_for(tool: &str) -> usize {
    match tool {
        "file_read" | "multi_file_read" => MAX_READ_RESULT_LENGTH,
        "workspace_tree" => MAX_TREE_RESULT_LENGTH,
        _ => MAX_TOOL_RESULT_LENGTH,
    }
}

/// Tools whose clamped results earn a full-fidelity `.rich.jsonl` sidecar
/// entry: the modify family, whose `oldContent`/`newContent` drive the
/// reload-time diff view. Reads are excluded — their model cap already
/// matches the UI cap, and re-persisting file bodies twice buys nothing.
fn rich_persisted_tool(name: &str) -> bool {
    matches!(
        name,
        "file_edit"
            | "file_write"
            | "file_create"
            | "file_patch"
            | "search_replace"
            | "multi_search_replace"
    )
}

/// Clamp a tool's stringified result to its per-tool cap and append a
/// `[truncated N bytes]` marker so the model knows the tail was dropped.
/// Operates on char boundaries (not byte boundaries) so a truncation point
/// inside a multi-byte UTF-8 sequence cannot produce invalid UTF-8.
fn truncate_tool_content(tool: &str, s: String) -> String {
    // Results carrying an `<aurora_image>` block (browser_screenshot) get
    // LEANIFIED, not clamped: the base64 body is stripped from the persisted /
    // model-history copy (the PNG lives on disk, referenced by the `src` header
    // attr, and is rehydrated at request-build time by `split_aurora_images`).
    // This keeps the JSONL tiny, stops the base64 being re-uploaded to the model
    // every turn, and means a reloaded thread never shows a raw base64 blob. A
    // blind byte clamp here would instead cut through the base64 and drop the
    // closing tag → adapter can't split the image → model "sees" nothing.
    if s.contains("<aurora_image ") {
        return leanify_aurora_images(&s);
    }
    // Reads that bounded themselves are handed to the model verbatim. They are
    // already exactly the window that was requested (or an explicitly forced
    // whole file), and a byte clamp here would cut the tail off that window —
    // which is precisely the content a following exact-match `file_edit` has to
    // reproduce character for character.
    if s.contains(crate::tools::file_workspace_search::EXACT_READ_MARKER) {
        return s;
    }
    let cap = result_cap_for(tool);
    if s.len() <= cap {
        return s;
    }
    if let Some(compacted) = compact_json_tool_content(&s, cap) {
        return compacted;
    }
    let original_len = s.len();
    // Walk char boundaries to find a safe slice point, leaving room for the
    // marker. Cutting at exactly `cap` and *then* appending the marker put
    // the result OVER the cap the function exists to enforce.
    let mut cut = cap.saturating_sub(TRUNCATION_MARKER_RESERVE);
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + 64);
    out.push_str(&s[..cut]);
    out.push_str(&format!(
        "\n\n[truncated {} bytes — tool returned {} bytes total, kept first {}]",
        original_len.saturating_sub(cut),
        original_len,
        cut,
    ));
    out
}

fn compact_json_tool_content(raw: &str, cap: usize) -> Option<String> {
    let original = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let mut low = 0usize;
    let mut high = cap;
    let mut best: Option<String> = None;

    while low <= high {
        let limit = low + (high - low) / 2;
        let mut candidate = original.clone();
        // A `false` return means "no payload string was longer than
        // `limit`" — NOT failure. Bailing out on it was wrong twice over:
        //   * `workspace_tree` has no payload-string keys at all, so the
        //     very first probe returned false and this aborted before ever
        //     reaching `compact_json_arrays` — the function written for
        //     exactly that shape. The result fell through to the blind byte
        //     clamp and came back as invalid JSON.
        //   * A batch `file_read` whose per-file contents are each smaller
        //     than the first probe (but huge in aggregate) hit the same
        //     path, so the one case the binary search exists to solve was
        //     the one it refused.
        // The serialized size below is the real signal; an unchanged
        // candidate simply measures too big and the search moves lower.
        let _ = shrink_history_payload_strings(&mut candidate, limit);
        if let serde_json::Value::Object(map) = &mut candidate {
            map.insert("historyTruncated".into(), serde_json::Value::Bool(true));
            map.insert(
                "originalBytes".into(),
                serde_json::Value::from(raw.len() as u64),
            );
        }
        let serialized = serde_json::to_string(&candidate).ok()?;
        if serialized.len() <= cap {
            best = Some(serialized);
            low = limit.saturating_add(1);
        } else if limit == 0 {
            break;
        } else {
            high = limit - 1;
        }
    }

    if best.is_some() {
        return best;
    }

    if let Some(compacted) = compact_json_arrays(&original, cap, raw.len()) {
        return Some(compacted);
    }

    let mut fallback = serde_json::Map::new();
    if let serde_json::Value::Object(map) = &original {
        for key in ["success", "message", "error", "path"] {
            if let Some(value) = map.get(key) {
                if !value.is_array() && !value.is_object() {
                    fallback.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    fallback.insert("historyTruncated".into(), serde_json::Value::Bool(true));
    fallback.insert(
        "originalBytes".into(),
        serde_json::Value::from(raw.len() as u64),
    );
    let compacted = serde_json::to_string(&serde_json::Value::Object(fallback)).ok()?;
    (compacted.len() <= cap).then_some(compacted)
}

fn compact_json_arrays(
    original: &serde_json::Value,
    cap: usize,
    original_len: usize,
) -> Option<String> {
    let mut candidate = original.clone();
    if let serde_json::Value::Object(map) = &mut candidate {
        map.insert("historyTruncated".into(), serde_json::Value::Bool(true));
        map.insert(
            "originalBytes".into(),
            serde_json::Value::from(original_len as u64),
        );
    }

    loop {
        let serialized = serde_json::to_string(&candidate).ok()?;
        if serialized.len() <= cap {
            return Some(serialized);
        }
        let largest = largest_json_array_len(&candidate);
        if largest == 0 || !shrink_json_arrays_of_len(&mut candidate, largest) {
            return None;
        }
    }
}

fn largest_json_array_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .map(largest_json_array_len)
            .fold(items.len(), usize::max),
        serde_json::Value::Object(map) => {
            map.values().map(largest_json_array_len).max().unwrap_or(0)
        }
        _ => 0,
    }
}

fn shrink_json_arrays_of_len(value: &mut serde_json::Value, target_len: usize) -> bool {
    match value {
        serde_json::Value::Array(items) => {
            if items.len() == target_len {
                items.truncate(items.len() / 2);
                return true;
            }
            items.iter_mut().fold(false, |changed, item| {
                shrink_json_arrays_of_len(item, target_len) || changed
            })
        }
        serde_json::Value::Object(map) => map.values_mut().fold(false, |changed, child| {
            shrink_json_arrays_of_len(child, target_len) || changed
        }),
        _ => false,
    }
}

fn shrink_history_payload_strings(value: &mut serde_json::Value, limit: usize) -> bool {
    let mut changed = false;
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                changed |= shrink_history_payload_strings(item, limit);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "content" | "oldContent" | "newContent" | "stdout" | "stderr" | "output"
                ) {
                    if let serde_json::Value::String(text) = child {
                        if text.len() > limit {
                            let original_len = text.len();
                            let mut cut = limit;
                            while cut > 0 && !text.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            text.truncate(cut);
                            text.push_str(&format!(
                                "\n\n[truncated {} bytes in persisted history]",
                                original_len.saturating_sub(cut),
                            ));
                            changed = true;
                        }
                    }
                } else {
                    changed |= shrink_history_payload_strings(child, limit);
                }
            }
        }
        _ => {}
    }
    changed
}

/// Backstop for the UI event payload. The model-history copy is hard
/// clamped at [`MAX_TOOL_RESULT_LENGTH`], but the UI deliberately gets
/// the *full* result so the rich renderers (workspace_tree, grep, shell
/// output) can parse complete JSON — a blind byte clamp chops the JSON
/// mid-string and the frontend falls back to dumping raw bytes.
///
/// Normal-sized results pass through untouched, preserving that
/// behavior. Only pathological payloads (multi-megabyte `cat`, verbose
/// build logs) are trimmed, and we do it JSON-aware: parse the value and
/// shrink its large *string* fields in place so the envelope stays valid
/// JSON the frontend can still parse. If it isn't JSON, fall back to a
/// plain char-boundary clamp (safe to chop — there's no structure to
/// break). This keeps megabyte blobs off the WebView2 IPC channel and
/// out of the thread store without reintroducing the raw-dump artifact.
const MAX_UI_TOOL_RESULT_LENGTH: usize = 512 * 1024; // 512 KiB
const MAX_UI_JSON_FIELD_LENGTH: usize = 128 * 1024; // 128 KiB per string field

fn truncate_tool_content_for_ui(tool_name: &str, s: String) -> String {
    if tool_name == "browser_screenshot" {
        return screenshot_ui_payload(&s);
    }

    if s.len() <= MAX_UI_TOOL_RESULT_LENGTH {
        return s;
    }

    // Try to keep the payload valid JSON by trimming oversized string
    // fields rather than the serialized envelope.
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&s) {
        shrink_json_strings(&mut value);
        if let Ok(compacted) = serde_json::to_string(&value) {
            return compacted;
        }
    }

    // Not JSON (or re-serialization failed): plain text is safe to chop.
    let original_len = s.len();
    let mut cut = MAX_UI_TOOL_RESULT_LENGTH;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + 64);
    out.push_str(&s[..cut]);
    out.push_str(&format!(
        "\n\n[truncated {} bytes for display — tool returned {} bytes total]",
        original_len.saturating_sub(cut),
        original_len,
    ));
    out
}

/// Build the UI-facing payload for a `browser_screenshot` result.
///
/// The model-history copy keeps the full `<aurora_image>…base64…</aurora_image>`
/// block (the vision path). The UI must NOT carry that base64 — it would bloat
/// every persisted thread. Instead we emit a small JSON envelope the tool card's
/// parser understands: the on-disk PNG `path` (asset-protocol loadable), its
/// pixel `width`/`height`, and the page `url`. The card renders the image from
/// `path`; no image bytes touch the thread store.
///
/// Falls back gracefully: if there's no `<aurora_image>` block at all (e.g. an
/// error string), the original text passes through unchanged.
fn screenshot_ui_payload(s: &str) -> String {
    let Some(open) = s.find("<aurora_image ") else {
        return s.to_string();
    };
    let Some(header_end_rel) = s[open..].find('>') else {
        return s.to_string();
    };
    let header = &s[open..open + header_end_rel];

    let path = header_attr(header, "src").map(unescape_xml_attr);
    let width = header_attr(header, "width").and_then(|v| v.parse::<u64>().ok());
    let height = header_attr(header, "height").and_then(|v| v.parse::<u64>().ok());

    // The caption after the block reads `Screenshot of <url> (WxH px)` — pull the
    // URL out of it for the card's summary line.
    let url = s
        .find("Screenshot of ")
        .map(|i| &s[i + "Screenshot of ".len()..])
        .and_then(|rest| rest.split(" (").next())
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    serde_json::json!({
        "screenshot": {
            "path": path,
            "width": width,
            "height": height,
            "url": url,
        }
    })
    .to_string()
}

/// Strip the base64 BODY out of every `<aurora_image src="…">…</aurora_image>`
/// block, leaving the header (with `src`/`width`/`height`) and surrounding text
/// intact. Only blocks that carry a `src` are leaned (the PNG is on disk and
/// re-readable); a block WITHOUT `src` (on-disk save failed → the body is the
/// only copy) is left untouched so the model still gets the image.
///
/// This is what makes the persisted history + JSONL tiny: `split_aurora_images`
/// rehydrates the base64 from `src` at request-build time.
fn leanify_aurora_images(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0usize;
    while let Some(rel) = s[cursor..].find("<aurora_image ") {
        let open = cursor + rel;
        let Some(header_end_rel) = s[open..].find('>') else {
            out.push_str(&s[cursor..]);
            return out;
        };
        let header_end = open + header_end_rel + 1; // just past '>'
        let Some(close_rel) = s[header_end..].find("</aurora_image>") else {
            out.push_str(&s[cursor..]);
            return out;
        };
        let close_start = header_end + close_rel;
        let header = &s[open..header_end];
        out.push_str(&s[cursor..header_end]); // text before + full header incl. '>'
        if header.contains("src=\"") {
            // Drop the base64 body — rehydratable from disk.
        } else {
            // No disk copy → keep the body so the image survives.
            out.push_str(&s[header_end..close_start]);
        }
        out.push_str("</aurora_image>");
        cursor = close_start + "</aurora_image>".len();
    }
    out.push_str(&s[cursor..]);
    out
}

/// Read a `name="value"` attribute out of an `<aurora_image …` header fragment.
/// Values never contain `"` (paths are XML-escaped upstream), so a naïve scan to
/// the next quote is sufficient.
fn header_attr(header: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = header.find(&needle)? + needle.len();
    let end = header[start..].find('"')? + start;
    Some(header[start..end].to_string())
}

/// Reverse the minimal XML-attribute escaping applied when the screenshot path
/// was written into the `src` attribute (`&amp;` → `&`, `&quot;` → `"`).
fn unescape_xml_attr(v: String) -> String {
    v.replace("&quot;", "\"").replace("&amp;", "&")
}

/// Recursively clamp every string in a JSON value to
/// [`MAX_UI_JSON_FIELD_LENGTH`], appending a marker so the UI can show
/// the field was trimmed. Truncates on char boundaries to keep the
/// string valid UTF-8.
fn shrink_json_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            if text.len() > MAX_UI_JSON_FIELD_LENGTH {
                let original_len = text.len();
                let mut cut = MAX_UI_JSON_FIELD_LENGTH;
                while cut > 0 && !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
                text.push_str(&format!(
                    "\n\n[truncated {} bytes for display]",
                    original_len.saturating_sub(cut),
                ));
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                shrink_json_strings(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                shrink_json_strings(v);
            }
        }
        _ => {}
    }
}

/// Fraction (percent) of the context window preserved verbatim as the recent
/// "tail" when compacting. Everything older is replaced by the LLM summary.
const COMPACT_TAIL_PCT: u32 = 30;

/// System prompt for the summarization call. Drives an LLM summary (not a
/// deterministic template) — fidelity over a generous budget is the whole
/// point of compaction over plain trimming.
const COMPACTION_SYSTEM_PROMPT: &str = "You are compacting a long coding-assistant conversation so it can continue without exceeding the model's context window. Produce a dense, faithful summary of everything below that a capable agent would need to seamlessly resume the work. You MUST preserve:\n\n- The user's overall goals and every explicit instruction or constraint still in force.\n- Decisions made and their rationale; rejected alternatives and why.\n- Files read, created, or edited — with their paths and the key contents/signatures that matter going forward.\n- Tool results that still affect the work (errors seen, command output, search findings); drop noise.\n- The current state: what is done, what is in progress, and what is left.\n- Any open questions, blockers, or pending todos.\n\nWrite in clear prose and lists. Be specific (exact names, paths, values) — do not generalize away detail the agent will need. Do not address the user; this is internal context, not a reply. Output ONLY the summary.";

/// Trailing user instruction appended to the head when requesting the summary.
const COMPACTION_INSTRUCTION: &str =
    "Summarize the entire conversation above following your system instructions. Output ONLY the summary.";

/// Build the model API view for a session that may carry compaction markers.
///
/// Replaces everything at or older than the LAST `ContentBlock::Compaction`
/// with its summary — folded onto the first user message of the verbatim tail
/// so the sequence stays user-led and valid for every provider — and keeps the
/// tail unchanged. A session with no marker round-trips unchanged. The
/// persisted JSONL is never touched; this is an API-view transform, exactly
/// like `inject_ide_context`/`trim_to_budget`, but summary-backed.
fn apply_compaction(messages: &[ConversationMessage]) -> Vec<ConversationMessage> {
    let Some(mi) = messages.iter().rposition(|m| {
        m.blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Compaction { .. }))
    }) else {
        return messages.to_vec();
    };
    let summary = messages[mi]
        .blocks
        .iter()
        .find_map(|b| match b {
            ContentBlock::Compaction { summary, .. } => Some(summary.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let preamble = format!("<conversation_summary>\n{summary}\n</conversation_summary>");

    let mut out: Vec<ConversationMessage> = messages[mi + 1..].to_vec();
    match out.first_mut() {
        Some(first) if first.role == MessageRole::User => match first.blocks.first_mut() {
            Some(ContentBlock::Text { text }) => {
                *text = format!("{preamble}\n\n{text}");
            }
            _ => first
                .blocks
                .insert(0, ContentBlock::Text { text: preamble }),
        },
        _ => {
            // Tail isn't user-led (markers normally sit at user boundaries, so
            // this is defensive) — prepend a standalone user summary so the API
            // view still starts with a user message.
            out.insert(
                0,
                ConversationMessage {
                    role: MessageRole::User,
                    blocks: vec![ContentBlock::Text { text: preamble }],
                    usage: None,
                    timestamp: messages[mi].timestamp,
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                },
            );
        }
    }
    out
}

/// Pick the message index to cut at when compacting: the OLDEST `User`
/// boundary whose verbatim tail still fits within [`COMPACT_TAIL_PCT`] of the
/// window (maximising preserved recent context up to the cap). Falls back to
/// the newest user boundary that still leaves a non-empty head if even the
/// last turn exceeds the cap. Returns `None` when no safe cut exists (fewer
/// than two user turns) so the caller skips compaction.
fn compaction_cut(messages: &[ConversationMessage], window: u32) -> Option<usize> {
    let target = (u64::from(window) * u64::from(COMPACT_TAIL_PCT) / 100) as u32;
    let per: Vec<u32> = messages.iter().map(estimate_message_tokens).collect();
    let mut suffix = vec![0u32; messages.len() + 1];
    for i in (0..messages.len()).rev() {
        suffix[i] = suffix[i + 1].saturating_add(per[i]);
    }
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| matches!(m.role, MessageRole::User).then_some(i))
        .collect();
    if user_indices.len() < 2 {
        return None;
    }
    // Oldest boundary (with a non-empty head) whose tail fits the cap.
    for &idx in &user_indices {
        if idx > 0 && suffix[idx] <= target {
            return Some(idx);
        }
    }
    // Even the last turn exceeds the cap — keep the smallest possible tail.
    user_indices.iter().rev().copied().find(|&idx| idx > 0)
}

/// Concatenate the visible text blocks of an assistant message (used to pull
/// the summary text out of the summarization call's reconstructed message).
fn collect_assistant_text(message: &ConversationMessage) -> String {
    let mut out = String::new();
    for block in &message.blocks {
        if let ContentBlock::Text { text } = block {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}

/// Trim the API-view of the session to fit a token budget.
///
/// Pure function: takes ownership of `messages`, returns the kept
/// suffix plus a count of dropped messages. The persisted session is
/// untouched — callers operate on a freshly cloned vector (mirroring
/// the IDE-context injection pattern).
///
/// Algorithm:
/// 1. Compute `budget = context_window - max_output * 1.1` (the
///    space left for the prompt after reserving for the response).
/// 2. Compute `threshold = budget * 0.75`.
/// 3. Count tokens of `system_prompt` plus every message via tiktoken
///    (cl100k). If the sum is within threshold, return unchanged.
/// 4. Find the cut point: the start of the (`PRESERVE_LAST_USER_TURNS`-th
///    from last) `User` message. Everything before that index gets
///    dropped. Cutting at a `User` boundary preserves tool_use ↔
///    tool_result coherence (a tool result never appears before its
///    own user-rooted turn) and keeps the alternation rule both
///    Anthropic and OpenAI APIs require.
/// 5. If there are fewer than `PRESERVE_LAST_USER_TURNS + 1` user
///    messages, no safe cut exists — return unchanged with `dropped: 0`.
///
/// `context_window == None` is the "no budget enforced" case and
/// short-circuits to no-op.
fn trim_to_budget(
    messages: Vec<ConversationMessage>,
    context_window: Option<u32>,
    max_output: u32,
    system_prompt: &str,
) -> TrimOutcome {
    let Some(window) = context_window else {
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    };

    let reserve = max_output
        .saturating_mul(OUTPUT_RESERVE_NUMER)
        .saturating_div(OUTPUT_RESERVE_DENOM);
    let budget = window.saturating_sub(reserve);
    if budget == 0 {
        // Pathological config (max_output >= window). Don't trim — let
        // the provider reject so the user sees the real error instead
        // of mysterious empty turns.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }
    let threshold = budget.saturating_mul(TRIM_THRESHOLD_PCT) / 100;

    let system_tokens = estimate_text_tokens(system_prompt);
    let per_msg_tokens: Vec<u32> = messages.iter().map(estimate_message_tokens).collect();
    let total: u32 = per_msg_tokens
        .iter()
        .copied()
        .fold(system_tokens, u32::saturating_add);

    if total <= threshold {
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // Find the indices of all User messages. We cut at one of these
    // boundaries to keep tool_use/tool_result pairing intact.
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| matches!(m.role, MessageRole::User).then_some(i))
        .collect();

    if user_indices.len() <= PRESERVE_LAST_USER_TURNS {
        // Nothing safe to drop — the budget is overrun by the most
        // recent turns themselves. Send as-is and let the provider
        // surface the real over-limit error.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // Greedy: pick the latest cut point that gets us under threshold.
    // Walking from oldest user-boundary to newest preserves "drop the
    // smallest amount of history needed".
    // Candidate cut points are the 2nd..=`max_cut`-th user boundaries.
    //
    // Both ends were wrong. Cutting at `user_indices[0]` is index 0, which
    // drops nothing — so the first candidate was always a no-op. And the
    // range excluded `max_cut` itself, even though cutting there still
    // leaves PRESERVE_LAST_USER_TURNS turns standing. Net effect: the trim
    // always under-dropped by one turn, and with exactly three user turns
    // (`max_cut == 1`) the only candidate was the no-op, so trimming never
    // fired at all — the request went out over budget and the provider
    // rejected it.
    let max_cut = user_indices.len() - PRESERVE_LAST_USER_TURNS;
    let mut best_cut_msg_idx = 0;
    let mut running = total;
    for &cut_idx in &user_indices[1..=max_cut] {
        // If we cut here we drop messages [0..cut_idx).
        // Subtract their token counts from `running`.
        // (We've previously subtracted everything up to the *previous*
        // candidate, so just subtract the new range incrementally.)
        let prev = best_cut_msg_idx;
        for tokens in per_msg_tokens.iter().take(cut_idx).skip(prev) {
            running = running.saturating_sub(*tokens);
        }
        best_cut_msg_idx = cut_idx;
        if running <= threshold {
            break;
        }
    }

    if best_cut_msg_idx == 0 {
        // No user boundary was past index 0 — nothing to drop.
        return TrimOutcome {
            messages,
            dropped: 0,
        };
    }

    // The notice we'll inject costs a few tokens too. Don't bother
    // accounting precisely — the threshold's 25% cushion absorbs it.
    let kept: Vec<ConversationMessage> = messages.into_iter().skip(best_cut_msg_idx).collect();
    TrimOutcome {
        messages: kept,
        dropped: best_cut_msg_idx,
    }
}

/// Append a `<context_trim_notice>` block to the system prompt so the
/// model knows it's seeing a partial transcript. Kept short and
/// machine-readable so it doesn't bias the assistant's tone.
fn build_trim_notice(base_prompt: &str, dropped: usize) -> String {
    let notice = format!(
        "<context_trim_notice>\n{dropped} earlier message(s) in this thread were trimmed from this request to keep it within the model's context window. The recent conversation is preserved verbatim. If the user asks about something that was in the trimmed history, ask them to restate it.\n</context_trim_notice>",
    );
    if base_prompt.is_empty() {
        notice
    } else {
        format!("{base_prompt}\n\n{notice}")
    }
}

/// Estimate token count of a plain string using cl100k (the encoding
/// the existing context engine uses). Falls back to a 4-chars-per-token
/// approximation if tiktoken initialization fails — the trim is
/// best-effort, not load-bearing for correctness.
fn estimate_text_tokens(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    use crate::services::token_service::{EncodingType, TokenService};
    TokenService::count_tokens(text, EncodingType::Cl100k)
        .map(|c| c.tokens as u32)
        .unwrap_or_else(|_| (text.len() as u32 + 3) / 4)
}

/// Flat per-image token estimate for the trim heuristic. Images are sent as
/// real `image`/`image_url` blocks and billed by the provider's tile/area
/// formula (a ~1024px image is roughly this many tokens), NOT by their base64
/// length — so counting the marker as text would over-count by ~100×. The trim
/// threshold's 25% cushion absorbs any imprecision in this flat figure.
const IMAGE_TOKEN_ESTIMATE: u32 = 1_100;

/// Token estimate for text that MAY embed `<aurora_image …>BASE64</aurora_image>`
/// markers (user-pasted/dropped images, or `browser_screenshot` results). The
/// base64 payload is excluded from the text token count and each marker instead
/// contributes a flat [`IMAGE_TOKEN_ESTIMATE`]. Without this a single image
/// would read as hundreds of thousands of tokens and falsely trip context
/// trimming.
fn estimate_text_with_images(text: &str) -> u32 {
    if !text.contains("<aurora_image ") {
        return estimate_text_tokens(text);
    }
    let mut images: u32 = 0;
    let mut stripped = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find("<aurora_image ") {
        let open = cursor + rel;
        stripped.push_str(&text[cursor..open]);
        match text[open..].find("</aurora_image>") {
            Some(close_rel) => {
                images = images.saturating_add(1);
                cursor = open + close_rel + "</aurora_image>".len();
            }
            None => {
                cursor = text.len();
            }
        }
    }
    stripped.push_str(&text[cursor..]);
    estimate_text_tokens(&stripped).saturating_add(images.saturating_mul(IMAGE_TOKEN_ESTIMATE))
}

/// Estimate the token cost of one [`ConversationMessage`].
///
/// Sums every block's textual content plus a small per-message and
/// per-block overhead matching the heuristic the legacy
/// `context::manager::ContextManager::count_round_tokens` uses (so the
/// trim's view of "how big is this turn" lines up with what the chat
/// indicator displayed under the old engine).
fn estimate_message_tokens(message: &ConversationMessage) -> u32 {
    let mut total: u32 = 4; // per-message overhead
    for block in &message.blocks {
        match block {
            ContentBlock::Text { text } => {
                // Excludes embedded image base64 (counts each image as a flat
                // estimate) so a pasted image doesn't read as ~100× its real
                // token cost.
                total = total.saturating_add(estimate_text_with_images(text));
            }
            ContentBlock::Thinking { text, signature } => {
                total = total.saturating_add(estimate_text_tokens(text));
                if let Some(sig) = signature {
                    total = total.saturating_add(estimate_text_tokens(sig));
                }
            }
            ContentBlock::ToolUse { name, input, .. } => {
                total = total.saturating_add(estimate_text_tokens(name));
                let json = input.to_string();
                total = total.saturating_add(estimate_text_tokens(&json));
                total = total.saturating_add(3); // tool-call overhead
            }
            ContentBlock::ToolResult { content, .. } => {
                // Screenshot results also embed `<aurora_image>` markers.
                total = total.saturating_add(estimate_text_with_images(content));
                total = total.saturating_add(4); // tool-result overhead
            }
            ContentBlock::Compaction { summary, .. } => {
                // In the model API view a compaction marker is replaced by its
                // summary (a single text block), so its token cost IS the
                // summary's. `apply_compaction` normally strips markers before
                // this runs; counting the summary keeps any stray call honest.
                total = total.saturating_add(estimate_text_tokens(summary));
            }
            ContentBlock::Notice { .. } => {
                // Costs nothing: notices are stripped from every provider view,
                // so counting them would inflate the context ring against
                // tokens that are never sent.
            }
        }
    }
    total
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

    #[test]
    fn screenshot_ui_result_omits_base64_and_emits_path_json() {
        let raw = "<aurora_image media_type=\"image/png\" width=\"800\" height=\"600\" src=\"C:\\cache\\shot-1.png\">QUJDREVGRw==</aurora_image>\nScreenshot of http://localhost:3001 (800×600 px)";
        let ui = truncate_tool_content_for_ui("browser_screenshot", raw.to_string());

        // No base64 reaches the UI / thread store.
        assert!(!ui.contains("QUJDREVGRw=="));
        // A structured payload the tool card can parse: path + dims + url.
        let v: serde_json::Value = serde_json::from_str(&ui).expect("valid JSON payload");
        let shot = &v["screenshot"];
        assert_eq!(shot["path"], "C:\\cache\\shot-1.png");
        assert_eq!(shot["width"], 800);
        assert_eq!(shot["height"], 600);
        assert_eq!(shot["url"], "http://localhost:3001");
    }

    #[test]
    fn screenshot_model_history_is_leaned_but_rehydratable() {
        // A screenshot WITH a `src` is leaned: base64 stripped, header (src/dims)
        // + caption + close tag kept, so the JSONL stays tiny and the adapter can
        // rehydrate the PNG from disk. It must NOT be byte-clamped (that would
        // chop the block and drop the close tag).
        let big_b64 = "A".repeat(20_000);
        let raw = format!(
            "<aurora_image media_type=\"image/png\" width=\"1400\" height=\"820\" src=\"C:\\cache\\shot.png\">{big_b64}</aurora_image>\nScreenshot of http://localhost:3001 (1400×820 px)"
        );
        let leaned = truncate_tool_content("browser_screenshot", raw);
        assert!(!leaned.contains(&big_b64), "base64 body must be stripped");
        assert!(
            leaned.contains("src=\"C:\\cache\\shot.png\""),
            "src pointer kept"
        );
        assert!(leaned.contains("</aurora_image>"), "close tag kept");
        assert!(
            leaned.contains("Screenshot of http://localhost:3001"),
            "caption kept"
        );
    }

    #[test]
    fn screenshot_without_src_keeps_inline_base64() {
        // If the on-disk save failed there's no `src`, so the body is the only
        // copy — it must survive leaning or the model loses the image entirely.
        let b64 = "B".repeat(12_000);
        let raw = format!(
            "<aurora_image media_type=\"image/png\" width=\"800\" height=\"600\">{b64}</aurora_image>\nScreenshot of http://localhost:3001 (800×600 px)"
        );
        let out = truncate_tool_content("browser_screenshot", raw);
        assert!(out.contains(&b64), "inline base64 kept when there's no src");
    }

    #[test]
    fn persisted_edit_result_stays_valid_json_when_large() {
        let raw = serde_json::json!({
            "success": true,
            "path": "src/App.tsx",
            "fullPath": "E:\\work\\src\\App.tsx",
            "linesAdded": 2,
            "linesRemoved": 2,
            "oldContent": "a".repeat(20_000),
            "newContent": "b".repeat(20_000),
        })
        .to_string();

        let compacted = truncate_tool_content("file_edit", raw.clone());
        assert!(compacted.len() <= MAX_TOOL_RESULT_LENGTH);
        let parsed: serde_json::Value =
            serde_json::from_str(&compacted).expect("history result must stay valid JSON");
        assert_eq!(parsed["path"], "src/App.tsx");
        assert_eq!(parsed["historyTruncated"], true);
        assert_eq!(parsed["originalBytes"], raw.len() as u64);
        assert!(parsed["oldContent"].as_str().unwrap().contains("truncated"));
        assert!(parsed["newContent"].as_str().unwrap().contains("truncated"));
    }

    #[test]
    fn persisted_multi_read_keeps_each_file_as_valid_json() {
        let raw = serde_json::json!({
            "success": true,
            "filesRead": 3,
            "files": [
                { "path": "a.ts", "success": true, "content": "a".repeat(240_000) },
                { "path": "b.ts", "success": true, "content": "b".repeat(240_000) },
                { "path": "c.ts", "success": true, "content": "c".repeat(240_000) },
            ]
        })
        .to_string();

        let compacted = truncate_tool_content("file_read", raw);
        assert!(compacted.len() <= MAX_READ_RESULT_LENGTH);
        let parsed: serde_json::Value =
            serde_json::from_str(&compacted).expect("batch read history must stay valid JSON");
        let files = parsed["files"].as_array().expect("files array");
        assert_eq!(files.len(), 3);
        assert!(files.iter().all(|file| file["content"]
            .as_str()
            .is_some_and(|content| !content.is_empty())));
    }

    #[test]
    fn persisted_structured_result_never_falls_back_to_broken_json() {
        // Well past even the tree's own cap, so the compactor is guaranteed to
        // engage — this test is about it producing VALID JSON, not about where
        // the threshold sits.
        let raw = serde_json::json!({
            "success": true,
            "tree": (0..40_000)
                .map(|index| serde_json::json!({
                    "name": format!("file-{index}.ts"),
                    "path": format!("src/generated/file-{index}.ts"),
                    "type": "file",
                }))
                .collect::<Vec<_>>(),
        })
        .to_string();

        let compacted = truncate_tool_content("workspace_tree", raw);
        let parsed: serde_json::Value =
            serde_json::from_str(&compacted).expect("structured history must stay valid JSON");
        // The tree has its own, larger cap — `MAX_TOOL_RESULT_LENGTH` would be
        // the wrong bound to assert here. See `result_cap_for`.
        assert!(compacted.len() <= result_cap_for("workspace_tree"));
        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["historyTruncated"], true);
        assert!(parsed["tree"]
            .as_array()
            .is_some_and(|tree| !tree.is_empty()));
    }

    /// A real-shaped `workspace_tree` result must reach the model INTACT. The
    /// tool now fits its own budget, so the compactor should never engage —
    /// that pass is what silently deleted `src/` from Aurora's own map.
    #[test]
    fn a_default_sized_tree_is_never_compacted() {
        // 500 nodes (the tool's default budget) at a realistic path length.
        let raw = serde_json::json!({
            "success": true,
            "rootPath": r"E:\VOID-EDITOR\Aurora-Agent-IDE",
            "tree": (0..500)
                .map(|index| serde_json::json!({
                    "name": format!("some_module_{index}.rs"),
                    "path": format!("src-tauri/src/tools/file_workspace_search/some_module_{index}.rs"),
                    "type": "file",
                    "lineCount": 420,
                }))
                .collect::<Vec<_>>(),
        })
        .to_string();

        let compacted = truncate_tool_content("workspace_tree", raw.clone());
        assert_eq!(compacted, raw, "a default-budget tree must pass through whole");
        let parsed: serde_json::Value = serde_json::from_str(&compacted).unwrap();
        assert!(parsed.get("historyTruncated").is_none());
        assert_eq!(parsed["tree"].as_array().unwrap().len(), 500);
    }

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

    #[test]
    fn malformed_input_error_quotes_what_arrived_and_names_the_cause() {
        // Cut off mid-string — the shape an output cap produces.
        let cut = r#"{"path":"src/main.rs","content":"fn main() {"#;
        let message = malformed_input_error("file_write", cut).to_string();

        assert!(message.contains("`file_write` was NOT executed"));
        assert!(message.contains(cut), "must quote the raw payload");
        assert!(
            message.contains("output-token limit"),
            "an EOF parse failure is a truncation, not a syntax error: {message}"
        );

        // A syntax error gets the other diagnosis and the other advice.
        let broken = r#"{"path":"C:\Users\x"}"#;
        let message = malformed_input_error("file_read", broken).to_string();
        assert!(
            !message.contains("output-token limit"),
            "complete-but-invalid JSON is not a truncation: {message}"
        );
        assert!(message.contains("unescaped backslash"));
    }

    #[test]
    fn malformed_input_error_elides_the_middle_of_a_huge_payload() {
        let raw = format!(r#"{{"content":"{}"#, "x".repeat(5_000));
        let message = malformed_input_error("file_write", &raw).to_string();

        assert!(message.contains("First 400 characters"));
        assert!(message.contains("Last 200 characters"));
        assert!(
            message.len() < 2_000,
            "the error must not itself flood the context: {} chars",
            message.len()
        );
    }

    #[tokio::test]
    async fn run_turn_does_not_dispatch_a_tool_whose_arguments_never_parsed() {
        // `parse_tool_input` encodes an unparseable payload as a raw string.
        // The dispatcher must answer it with MalformedInput instead of
        // handing the executor an empty object and letting it report a
        // missing field to a model that sent one.
        let raw = r#"{"msg":"unterminated"#;
        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use("call-bad", "echo", serde_json::json!(raw)),
                    "tool_use",
                )),
            },
            TurnScript {
                events: vec![],
                result: Ok(turn_usage(assistant_text("ok"), "end_turn")),
            },
        ]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "should never run".into(),
        }));
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);

        let summary = runtime
            .run_turn(&mut session, user_msg("?"), tx, CancellationToken::new())
            .await
            .expect("ok");

        assert!(
            seen.lock().expect("seen mutex").is_empty(),
            "the executor must never be reached with fabricated arguments"
        );

        match &summary.tool_results[0].blocks[0] {
            ContentBlock::ToolResult {
                content, is_error, ..
            } => {
                assert_eq!(*is_error, Some(true));
                assert!(content.contains("was NOT executed"), "{content}");
                assert!(content.contains(raw), "must quote the payload: {content}");
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn failure_loop_guard_escalates_only_on_repeats() {
        let mut guard = FailureLoopGuard::default();
        let args = serde_json::json!({"path": "a.rs", "old_string": "x"});

        // First failure reads normally — a single miss is not a loop.
        assert!(guard.record_failure("file_edit", &args).is_none());

        let second = guard
            .record_failure("file_edit", &args)
            .expect("escalation");
        assert!(second.contains("SECOND time"));
        assert!(second.contains("re-read the file"));

        let third = guard
            .record_failure("file_edit", &args)
            .expect("escalation");
        assert!(third.contains("STOP"));
        assert!(third.contains("failed 3 times"));

        // Different arguments are a different attempt, not a repeat.
        let other = serde_json::json!({"path": "b.rs", "old_string": "x"});
        assert!(guard.record_failure("file_edit", &other).is_none());
        // …and so is the same arguments on a different tool.
        assert!(guard.record_failure("search_replace", &args).is_none());
    }

    #[test]
    fn failure_loop_guard_resets_after_a_success() {
        let mut guard = FailureLoopGuard::default();
        let args = serde_json::json!({"command": "cargo test"});

        assert!(guard.record_failure("shell_execute", &args).is_none());
        guard.clear("shell_execute", &args);
        assert!(
            guard.record_failure("shell_execute", &args).is_none(),
            "a success means the situation changed — counting starts fresh"
        );
    }

    #[test]
    fn length_stop_is_recognized_across_provider_spellings() {
        assert!(is_length_stop("length"));
        assert!(is_length_stop("max_tokens"));
        assert!(!is_length_stop("end_turn"));
        assert!(!is_length_stop("tool_use"));
        assert!(!is_length_stop("stop"));
    }

    /// Executor that blocks until released, so a test can prove two calls
    /// were genuinely in flight at once rather than merely fast.
    struct GateTool {
        name: &'static str,
        concurrent: bool,
        entered: Arc<tokio::sync::Semaphore>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl super::super::tool_executor::ToolExecutor for GateTool {
        fn name(&self) -> &str {
            self.name
        }
        fn concurrency_safe(&self) -> bool {
            self.concurrent
        }
        fn schema(&self) -> super::super::api_client::ToolSchema {
            super::super::api_client::ToolSchema {
                name: self.name.into(),
                description: "gate".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }
        }
        async fn execute(
            &self,
            _input: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            self.entered.add_permits(1);
            self.release.notified().await;
            Ok("done".into())
        }
    }

    #[tokio::test]
    async fn concurrency_safe_calls_in_one_batch_run_at_the_same_time() {
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Notify::new());

        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(GateTool {
            name: "reader",
            concurrent: true,
            entered: entered.clone(),
            release: release.clone(),
        }));

        let calls: Vec<PendingToolCall> = (0..3)
            .map(|i| PendingToolCall {
                id: format!("call-{i}"),
                name: "reader".into(),
                input: serde_json::json!({ "n": i }),
            })
            .collect();

        let runtime = ConversationRuntime::new(
            Arc::new(MockApi::new(vec![])),
            tools,
            RuntimeConfig::default(),
        );
        let session = Session::new("t");
        let (tx, _rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let mut seq = 0u64;

        // Release only once all three have entered. If dispatch were
        // sequential this would deadlock, so the timeout IS the assertion.
        let waiter = tokio::spawn({
            let entered = entered.clone();
            let release = release.clone();
            async move {
                let _ = entered.acquire_many(3).await.expect("all three entered");
                release.notify_waiters();
            }
        });

        let message = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runtime.execute_tool_calls(calls, &session, "turn-1", &cancel, &tx, &mut seq),
        )
        .await
        .expect("three concurrency-safe calls must overlap, not serialize")
        .expect("ok");

        waiter.await.expect("waiter");
        assert_eq!(message.blocks.len(), 3);
        // Order follows the model's call order, not completion order.
        for (i, block) in message.blocks.iter().enumerate() {
            match block {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    assert_eq!(tool_use_id, &format!("call-{i}"));
                }
                other => panic!("expected ToolResult, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn a_non_concurrent_tool_splits_the_batch_and_keeps_order() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "reader",
            seen: seen.clone(),
            response: "r".into(),
        }));
        tools.register(Arc::new(RecordingTool {
            name: "writer",
            seen: seen.clone(),
            response: "w".into(),
        }));

        let runtime = ConversationRuntime::new(
            Arc::new(MockApi::new(vec![])),
            tools.clone(),
            RuntimeConfig::default(),
        );

        // RecordingTool leaves `concurrency_safe` at its default (false),
        // so every call must run alone.
        let calls: Vec<PendingToolCall> = ["reader", "writer", "reader"]
            .iter()
            .enumerate()
            .map(|(i, name)| PendingToolCall {
                id: format!("c{i}"),
                name: (*name).into(),
                input: serde_json::json!({ "i": i }),
            })
            .collect();

        assert_eq!(
            runtime.concurrent_batch_len(&calls),
            1,
            "an unsafe tool at the head must run alone"
        );

        let session = Session::new("t");
        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0u64;
        let message = runtime
            .execute_tool_calls(
                calls,
                &session,
                "turn-1",
                &CancellationToken::new(),
                &tx,
                &mut seq,
            )
            .await
            .expect("ok");

        assert_eq!(message.blocks.len(), 3);
        assert_eq!(seen.lock().expect("seen").len(), 3);
    }

    #[test]
    fn batch_splits_at_the_first_unsafe_call() {
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(GateTool {
            name: "reader",
            concurrent: true,
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Notify::new()),
        }));
        tools.register(Arc::new(GateTool {
            name: "writer",
            concurrent: false,
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Notify::new()),
        }));
        let runtime = ConversationRuntime::new(
            Arc::new(MockApi::new(vec![])),
            tools,
            RuntimeConfig::default(),
        );

        let call = |name: &str, i: usize| PendingToolCall {
            id: format!("c{i}"),
            name: name.into(),
            input: serde_json::json!({}),
        };

        // [read, read, write, read] → batch of 2, then 1, then 1.
        let calls = vec![
            call("reader", 0),
            call("reader", 1),
            call("writer", 2),
            call("reader", 3),
        ];
        assert_eq!(runtime.concurrent_batch_len(&calls), 2);
        assert_eq!(runtime.concurrent_batch_len(&calls[2..]), 1);
        assert_eq!(runtime.concurrent_batch_len(&calls[3..]), 1);

        // An unknown tool never executes, so it cannot conflict with anything.
        let unknown = vec![call("nope", 0), call("reader", 1)];
        assert_eq!(runtime.concurrent_batch_len(&unknown), 2);
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

    /// The id a tool receives must be the THREAD, not `Session::session_id`.
    ///
    /// This was wrong in production and nothing caught it: `session_id` is a
    /// fresh UUIDv4 on every load, so the todo tool wrote its sidecar to
    /// `<uuid>.todos.json`, announced the list to the UI under a thread id that
    /// did not exist (the header indicator stayed empty), and lost everything on
    /// restart. Every tool-visible id is asserted here so the two can never be
    /// confused again.
    #[tokio::test]
    async fn tools_receive_the_thread_id_never_the_ephemeral_session_id() {
        struct IdSpy {
            seen: Arc<Mutex<Vec<String>>>,
        }
        #[async_trait]
        impl super::super::tool_executor::ToolExecutor for IdSpy {
            fn name(&self) -> &str {
                "echo"
            }
            fn schema(&self) -> super::super::api_client::ToolSchema {
                super::super::api_client::ToolSchema {
                    name: "echo".into(),
                    description: "id spy".into(),
                    input_schema: serde_json::json!({"type":"object"}),
                }
            }
            async fn execute(
                &self,
                _input: serde_json::Value,
                ctx: &ToolContext,
            ) -> Result<String, ToolError> {
                self.seen
                    .lock()
                    .expect("seen mutex")
                    .push(ctx.thread_id.clone());
                Ok("ok".into())
            }
        }

        let api = Arc::new(MockApi::new(vec![
            TurnScript {
                events: vec![],
                result: Ok(TurnUsage {
                    usage: TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                    },
                    stop_reason: "tool_use".into(),
                    assistant_message: assistant_tool_use("c1", "echo", serde_json::json!({})),
                }),
            },
            TurnScript {
                events: vec![],
                result: Ok(TurnUsage {
                    usage: TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                    },
                    stop_reason: "end_turn".into(),
                    assistant_message: assistant_text("done"),
                }),
            },
        ]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(IdSpy { seen: seen.clone() }));
        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());

        let mut session = Session::new("thread-abc");
        let ephemeral = session.session_id.clone();
        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
            .await
            .expect("turn");

        let ids = seen.lock().expect("seen mutex").clone();
        assert_eq!(ids, vec!["thread-abc".to_string()]);
        assert_ne!(
            ids[0], ephemeral,
            "a per-load UUID must never reach a tool as its conversation id"
        );
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
        // Reasoning bills against this cap on most providers, so the default
        // has to leave room for a long think AND a full reply (was 8192, which
        // a high reasoning effort could consume entirely).
        assert_eq!(captured.max_output_tokens, 16_384);
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

    // ── Budget-aware trim tests ────────────────────────────────────────
    //
    // Pure unit tests for `trim_to_budget` / `build_trim_notice` plus an
    // integration test that asserts the runtime forwards a trimmed
    // message slice + an augmented system prompt to the API once a
    // session blows past the configured window.

    fn user_with_text(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::user_text(text, ts)
    }

    fn assistant_with_text(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::assistant(vec![ContentBlock::Text { text: text.into() }], ts)
    }

    /// Building block for trim tests: 60 char text yields ~15 tokens
    /// under cl100k. Used to construct sessions whose total token count
    /// is predictable enough to compare against a budget.
    const FILLER_60: &str = "0123456789012345678901234567890123456789012345678901234567";

    #[test]
    fn trim_is_noop_when_context_window_is_none() {
        let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
        let outcome = trim_to_budget(messages.clone(), None, 4096, "");
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.messages, messages);
    }

    #[test]
    fn trim_is_noop_when_under_threshold() {
        // 200k window minus 4096 reserved → ~195k budget; threshold is
        // ~146k. Two short messages don't come close.
        let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
        let outcome = trim_to_budget(messages.clone(), Some(200_000), 4096, "system");
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.messages.len(), 2);
    }

    #[test]
    fn trim_drops_oldest_user_turn_when_over_threshold() {
        // Tiny window (1000 tokens) with a 100-token reserve → budget
        // 890, threshold ~667. Each big_text is ~250 tokens; three
        // user-anchored turns will exceed the threshold.
        let big = FILLER_60.repeat(60); // ~900 chars → ~225 tokens cl100k
        let messages = vec![
            user_with_text(&big, 0), // turn 1
            assistant_with_text(&big, 1),
            user_with_text(&big, 2), // turn 2
            assistant_with_text(&big, 3),
            user_with_text("latest", 4), // turn 3 (latest)
            assistant_with_text("reply", 5),
        ];

        let outcome = trim_to_budget(messages, Some(1000), 100, "");

        // Should drop the first turn (user + assistant = 2 messages),
        // keep the last 2 user-anchored turns intact.
        assert_eq!(outcome.dropped, 2, "must drop the oldest turn");
        assert_eq!(outcome.messages.len(), 4);
        // First kept message must be a User (we cut at a user boundary).
        assert_eq!(outcome.messages[0].role, MessageRole::User);
        // The latest turn is intact.
        assert!(matches!(
            &outcome.messages[2].blocks[0],
            ContentBlock::Text { text } if text == "latest"
        ));
    }

    #[test]
    fn trim_refuses_to_drop_below_preserve_floor() {
        // Only two user-rooted turns total; PRESERVE_LAST_USER_TURNS = 2,
        // so there's nothing safe to drop even if we're over budget.
        let big = FILLER_60.repeat(200); // ~750 tokens
        let messages = vec![
            user_with_text(&big, 0),
            assistant_with_text(&big, 1),
            user_with_text(&big, 2),
            assistant_with_text(&big, 3),
        ];

        let outcome = trim_to_budget(messages.clone(), Some(1000), 100, "");

        assert_eq!(outcome.dropped, 0, "no safe cut → no-op");
        assert_eq!(outcome.messages.len(), 4);
    }

    #[test]
    fn trim_keeps_tool_use_and_tool_result_paired() {
        // Cut at a User boundary so a Tool message never lands at index
        // 0 of the kept slice (which would orphan its tool_use_id).
        let big = FILLER_60.repeat(60);
        let tool_use = ConversationMessage::assistant(
            vec![ContentBlock::ToolUse {
                id: "call-1".into(),
                name: "echo".into(),
                input: serde_json::json!({"x": 1}),
            }],
            10,
        );
        let tool_result = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "call-1".into(),
                content: big.clone(),
                is_error: None,
            }],
            usage: None,
            timestamp: 11,
            attached_selected_elements: None,
            attached_prompt_chips: None,
        };
        let messages = vec![
            user_with_text(&big, 0),
            tool_use,
            tool_result,
            user_with_text(&big, 12),
            assistant_with_text(&big, 13),
            user_with_text("now", 14),
            assistant_with_text("done", 15),
        ];

        let outcome = trim_to_budget(messages, Some(1000), 100, "");

        // Whatever gets dropped, the first kept message MUST be a User.
        assert!(outcome.dropped > 0, "expected at least one drop");
        assert_eq!(
            outcome.messages[0].role,
            MessageRole::User,
            "trim must cut on a user boundary so tool pairs stay intact"
        );
        // No orphaned Tool message at index 0.
        for msg in &outcome.messages {
            if msg.role == MessageRole::Tool {
                // Every Tool message must follow an Assistant in the kept
                // slice — find the preceding tool_use by id.
                let rid = match &msg.blocks[0] {
                    ContentBlock::ToolResult { tool_use_id, .. } => tool_use_id.clone(),
                    _ => panic!("tool message must carry a ToolResult block"),
                };
                let has_matching_use = outcome.messages.iter().any(|m| {
                    m.blocks.iter().any(|b| {
                        matches!(b,
                        ContentBlock::ToolUse { id, .. } if id == &rid)
                    })
                });
                assert!(
                    has_matching_use,
                    "tool_result {rid} must have its tool_use in the kept slice"
                );
            }
        }
    }

    #[test]
    fn trim_handles_pathological_max_output_greater_than_window() {
        // Window 1000, max_output 5000 → reserve = 5500 > window.
        // budget saturates to 0; we should bail out without touching
        // the message list (let the provider surface the real error).
        let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
        let outcome = trim_to_budget(messages.clone(), Some(1000), 5000, "");
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.messages, messages);
    }

    #[test]
    fn build_trim_notice_appends_to_existing_prompt() {
        let out = build_trim_notice("you are aurora", 7);
        assert!(out.starts_with("you are aurora"));
        assert!(out.contains("<context_trim_notice>"));
        assert!(out.contains("7 earlier message(s)"));
        assert!(out.ends_with("</context_trim_notice>"));
    }

    #[test]
    fn build_trim_notice_handles_empty_base_prompt() {
        let out = build_trim_notice("", 3);
        assert!(out.starts_with("<context_trim_notice>"));
        assert!(out.contains("3 earlier message(s)"));
    }

    #[test]
    fn estimate_message_tokens_includes_per_message_overhead() {
        let m = user_with_text("", 0);
        // Empty text + 4 per-message overhead.
        assert_eq!(estimate_message_tokens(&m), 4);
    }

    #[test]
    fn estimate_message_tokens_accounts_for_tool_use_arguments() {
        let m = ConversationMessage::assistant(
            vec![ContentBlock::ToolUse {
                id: "x".into(),
                name: "shell".into(),
                input: serde_json::json!({"cmd": "ls -la /tmp"}),
            }],
            0,
        );
        // 4 (msg) + ≥1 (name) + ≥4 (json) + 3 (tool overhead)
        assert!(estimate_message_tokens(&m) >= 12);
    }

    /// API mock that records every messages slice it sees so we can
    /// assert what was actually trimmed.
    #[derive(Default)]
    struct CapturingTrimApi {
        captured: Mutex<Vec<(Option<String>, Vec<ConversationMessage>)>>,
    }

    #[async_trait]
    impl StreamingApiClient for CapturingTrimApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            self.captured.lock().expect("captured").push((
                request.system_prompt.map(str::to_string),
                request.messages.to_vec(),
            ));
            Ok(turn_usage(assistant_text("ok"), "end_turn"))
        }
    }

    #[tokio::test]
    async fn run_turn_trims_session_and_appends_trim_notice_when_over_budget() {
        // Pre-seed a session with three user-rooted turns where the
        // first two are large enough to exceed a tight budget.
        let big = FILLER_60.repeat(60); // ~225 tokens cl100k
        let mut session = Session::new("t");
        session.append_message(user_with_text(&big, 0));
        session.append_message(assistant_with_text(&big, 1));
        session.append_message(user_with_text(&big, 2));
        session.append_message(assistant_with_text(&big, 3));
        // Third user message comes from `run_turn` itself.

        let api = Arc::new(CapturingTrimApi::default());
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                system_prompt: Some("you are aurora".into()),
                default_max_output_tokens: 100,
                context_window: Some(1000),
                ..RuntimeConfig::default()
            },
        );

        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("now"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = api.captured.lock().expect("captured");
        let (sys, msgs) = captured.first().expect("api was called");

        // Trim notice was appended to the system prompt.
        let sys = sys.as_deref().expect("system prompt was set");
        assert!(
            sys.contains("<context_trim_notice>"),
            "system prompt should carry trim notice, got: {sys}"
        );
        assert!(
            sys.contains("you are aurora"),
            "original prompt must be preserved, got: {sys}"
        );

        // The first kept message must be a User (cut at user boundary).
        assert_eq!(msgs[0].role, MessageRole::User);
        // The latest user message ("now") must still be present.
        assert!(
            msgs.iter().any(|m| matches!(
                &m.blocks[0],
                ContentBlock::Text { text } if text == "now"
            )),
            "latest user message must survive trim"
        );

        // Persisted session is untouched — still 5 messages (4 seeded + 1
        // appended user + 1 appended assistant from MockApi return).
        assert_eq!(session.len(), 6);
    }

    #[tokio::test]
    async fn run_turn_does_not_trim_when_context_window_is_none() {
        // No window set → legacy behaviour: send everything every turn.
        let big = FILLER_60.repeat(60);
        let mut session = Session::new("t");
        session.append_message(user_with_text(&big, 0));
        session.append_message(assistant_with_text(&big, 1));
        session.append_message(user_with_text(&big, 2));
        session.append_message(assistant_with_text(&big, 3));

        let api = Arc::new(CapturingTrimApi::default());
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                system_prompt: Some("you are aurora".into()),
                default_max_output_tokens: 100,
                context_window: None,
                ..RuntimeConfig::default()
            },
        );

        let (tx, _rx) = mpsc::channel(32);
        runtime
            .run_turn(&mut session, user_msg("now"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let captured = api.captured.lock().expect("captured");
        let (sys, msgs) = captured.first().expect("api was called");

        // System prompt unmodified.
        assert_eq!(sys.as_deref(), Some("you are aurora"));
        // All 5 messages (4 seeded + the new user) reach the API.
        assert_eq!(msgs.len(), 5, "no trim → full session sent");
    }
}
