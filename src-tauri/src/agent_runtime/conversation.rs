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

use super::api_client::{ApiError, ApiRequest, StreamingApiClient, ToolSchema};
use super::error::RuntimeError;
use super::events::{AssistantEvent, TurnCompletion};
use super::hooks::{Hook, NoopHook, ToolHookResult};
use super::ipc::AgentEventEnvelope;
use super::session::{RichToolResult, Session};
use super::tool_executor::{ToolContext, ToolError, ToolRegistry};
use super::tool_pairing::{
    repair_tool_pairing, synthetic_tool_results, STOPPED_BEFORE_RUN, STOPPED_MID_RUN,
    TRUNCATED_CALL,
};
use super::types::{ContentBlock, ConversationMessage, MessageRole, TokenUsage};
use crate::api::ReasoningReplay;

/// Attempts at one model call before the turn gives up.
///
/// Three, not one, because a dropped stream was the most common real
/// failure this runtime saw and every one of them ended a turn the user
/// then restarted by hand. Three, not more, because each attempt
/// re-sends the whole conversation, and a failure that survives three
/// tries is almost never one that a fourth would clear.
///
/// Only errors [`ApiError::is_retryable`] admits are counted here — a
/// rejected request shape or a bad key fails once and stops.
const MAX_STREAM_ATTEMPTS: u32 = 3;

/// Base backoff before re-issuing a failed model call, doubling per
/// attempt: 1s, then 2s, then 4s… At [`MAX_STREAM_ATTEMPTS`] = 3 only
/// the first two are ever used, so a fully-failed call costs ~3s of
/// waiting on top of the attempts themselves.
///
/// Starting at a second rather than immediately: a gateway swapping to a
/// healthy upstream needs a moment, and an instant retry usually just
/// buys the same error. Doubling rather than flat: if the first wait was
/// not enough, the second almost certainly needs to be longer.
const STREAM_RETRY_BASE_DELAY_MS: u64 = 1_000;

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

    /// What this provider does with a stored reasoning block on replay, and
    /// therefore what one costs the next request. Set from the turn's provider
    /// type by `build_runtime_config`; see [`ReasoningReplay`].
    ///
    /// Defaults to [`ReasoningReplay::Dropped`] — the majority behaviour, and
    /// the safe default for a config built without provider knowledge (it
    /// counts nothing that might not be sent).
    pub reasoning_replay: ReasoningReplay,
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
            // Covers the `<analysis>` drafting pass AND the note itself — see
            // `COMPACTION_SYSTEM_PROMPT`. Too small and the scratchpad starves
            // the note of its last, most important sections.
            compaction_summary_budget: 16_000,
            allow_outside_workspace: false,
            reasoning_replay: ReasoningReplay::Dropped,
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
    /// Dedicated client + model for the summarization call, when the user
    /// pinned a compaction model. `None` summarizes on `api_client` with the
    /// session's own model.
    ///
    /// Held separately rather than swapped into `api_client` because only ONE
    /// request in a turn is the summary — everything else must still run on
    /// the model the user is chatting with.
    compaction_client: Option<(Arc<dyn StreamingApiClient>, String)>,
    /// Memoized tool-schema token count — see
    /// [`Self::fixed_request_overhead_tokens`]. Behind an `Arc` so the runtime
    /// stays cheap to clone and clones share the one computation.
    tool_schema_tokens: Arc<std::sync::OnceLock<u32>>,
    /// Memoized `<repo_map>` block for this conversation.
    ///
    /// Computed ONCE and reused for every turn, which is the whole point: the
    /// block sits at the head of the first user message, so if its text changed
    /// between turns it would invalidate the provider's cached prefix and
    /// re-bill the entire conversation. A map that drifts slightly out of date
    /// costs nothing — `code` is the live source, this is only orientation.
    repo_map: Arc<std::sync::OnceLock<Option<String>>>,
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
            compaction_client: None,
            tool_schema_tokens: Arc::new(std::sync::OnceLock::new()),
            repo_map: Arc::new(std::sync::OnceLock::new()),
        }
    }

    /// Run the summarization call on its own provider and model instead of the
    /// conversation's.
    ///
    /// Summarizing is a mechanical read of history, so it does not need the
    /// model doing the work — and it is routinely the single largest request a
    /// long chat makes. Pinning it also decouples compaction from the chat
    /// model's context window, so a conversation that outgrew a small model can
    /// still be compacted by a long-window one.
    #[must_use]
    pub fn with_compaction_client(
        mut self,
        client: Arc<dyn StreamingApiClient>,
        model: impl Into<String>,
    ) -> Self {
        self.compaction_client = Some((client, model.into()));
        self
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
        // One free re-issue when the provider hands back a response with no
        // content blocks at all. See the empty-reply branch below.
        let mut retried_empty_reply = false;
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

            // The event channel and its forwarder are built per *attempt*,
            // down in the retry loop — a forwarder ends with the stream that
            // feeds it, so a retry needs a fresh pair.

            // Apply any persisted compaction first: replace everything at
            // or older than the last compaction marker with its summary,
            // keeping the verbatim tail. The persisted JSONL keeps the full
            // history (the UI shows it); only this API view shrinks — the
            // same contract `inject_ide_context`/`trim` follow. A no-marker
            // session round-trips unchanged.
            let compacted = self.compacted_view(session);

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

            // Orientation for the workspace: what exists and roughly where.
            // Built from the same index the `code` tool reads, so the two can
            // never describe different codebases.
            //
            // Failure here is silent by design — the map is a convenience, and
            // an unindexable workspace must not cost the user their turn. The
            // agent still has `code`, `grep` and `workspace_tree`.
            let owned_messages: Option<Vec<ConversationMessage>> =
                match self.repo_map_block(session.workspace_root.as_deref()) {
                    Some(block) => Some(inject_repo_map(
                        owned_messages.as_deref().unwrap_or(&compacted),
                        &block,
                    )),
                    None => owned_messages,
                };

            // The live checklist, re-read from the store on EVERY request so a
            // mid-turn update is reflected on the very next iteration. This is
            // what keeps the model from having to remember its own list — or
            // call `op: "read"` to recover it after a compaction.
            let owned_messages: Option<Vec<ConversationMessage>> =
                match task_reminder_block(&session.thread_id) {
                    Some(reminder) => Some(inject_task_reminder(
                        owned_messages.as_deref().unwrap_or(&compacted),
                        &reminder,
                    )),
                    None => owned_messages,
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
                self.config.reasoning_replay,
            );

            // Last gate before the wire: every `tool_use` must be answered and
            // every `tool_result` earned, or the provider rejects the request
            // with a 400 before generating a token — and keeps rejecting it,
            // because the malformed history is on disk.
            //
            // Runs LAST so it also covers orphans introduced by the two views
            // above (a compaction marker or trim cut landing between a call and
            // its result), not just the ones already in the session. API-view
            // only: the persisted JSONL keeps what actually happened.
            let repair = repair_tool_pairing(trim_outcome.messages);
            if repair.changed() {
                eprintln!(
                    "agent_runtime: repaired tool pairing for turn {turn_id} \
                     ({} unanswered call(s) answered, {} orphaned result(s) dropped)",
                    repair.synthesized, repair.dropped,
                );
            }
            let messages_for_api: &[ConversationMessage] = &repair.messages;

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

            // ── The model call, with retry ─────────────────────────
            //
            // A dropped connection was the single most common real failure
            // on this runtime, and every one of them ended the turn and
            // waited for the user to notice and press Retry by hand. The
            // request is rebuilt byte-identical on each attempt, so the
            // retry re-reads the provider's prompt cache rather than paying
            // for a fresh prompt.
            let mut attempt: u32 = 1;
            let stream_result = loop {
                // Internal event channel: API impl pushes `AssistantEvent`
                // onto `api_tx`; a forwarder task wraps each in an envelope
                // and pushes it onto the caller's sink. Rebuilt per attempt,
                // starting from the `seq` the previous attempt reached so
                // the frontend's ordering stays monotonic across a retry.
                let (api_tx, api_rx) = mpsc::channel::<AssistantEvent>(64);
                let forwarder =
                    spawn_event_forwarder(turn_id.clone(), seq, api_rx, event_sink.clone());

                // Borrows only — rebuilding it per attempt costs nothing.
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

                let result = self
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

                let api_err = match result {
                    Ok(turn) => break Ok(turn),
                    Err(err) => err,
                };

                // A Stop outranks whatever the dying stream reported. The user
                // asked for the turn to end; showing them a network error
                // answers a question they did not ask, and the callers key
                // off `is_cancellation()` to stay quiet about it.
                if cancel_token.is_cancelled() {
                    break Err(ApiError::Cancelled);
                }

                // Out of attempts, or an error that re-issuing cannot fix.
                // A cancel the stream itself reported lands here too —
                // `Cancelled` is not retryable — and keeps its own identity.
                if attempt >= MAX_STREAM_ATTEMPTS || !api_err.is_retryable() {
                    break Err(api_err);
                }

                let delay_ms = STREAM_RETRY_BASE_DELAY_MS << (attempt - 1);

                crate::logging::log_warn(
                    "agent_runtime.turn",
                    &format!(
                        "stream attempt {attempt}/{MAX_STREAM_ATTEMPTS} failed on turn \
                         {turn_id} (thread {}, model {model}, iteration {iterations}): \
                         {api_err} — retrying in {delay_ms}ms",
                        session.thread_id,
                    ),
                );

                // Whatever streamed before the connection died is on screen
                // and about to be streamed again from the top. Tell the
                // frontend to drop it, or the reply renders twice.
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::PartialReplyDiscarded {
                        attempt,
                        max_attempts: MAX_STREAM_ATTEMPTS,
                        reason: api_err.to_string(),
                    },
                };
                seq = seq.saturating_add(1);
                let _ = event_sink.send(envelope).await;

                // Interruptible backoff: someone who presses Stop during the
                // wait must not sit through the rest of it.
                let cancelled_while_waiting = tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => false,
                    _ = cancel_token.cancelled() => true,
                };
                if cancelled_while_waiting {
                    break Err(ApiError::Cancelled);
                }

                attempt = attempt.saturating_add(1);
            };

            let turn = match stream_result {
                Ok(t) => t,
                Err(api_err) => {
                    // Every failed model call leaves a trace on disk. The UI
                    // only ever shows `api_err.to_string()` — this line is
                    // where a production incident's context survives. A
                    // user-pressed Stop is not an error and is not logged.
                    if !matches!(api_err, ApiError::Cancelled) {
                        crate::logging::log_error(
                            "agent_runtime.turn",
                            &format!(
                                "stream failed on turn {turn_id} (thread {}, model {model}, \
                                 iteration {iterations}) after {attempt} attempt(s): {api_err}",
                                session.thread_id,
                            ),
                        );
                    }
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
                let tools_tokens = estimate_tool_schema_tokens(&tool_schemas);
                let input = messages_for_api
                    .iter()
                    .map(|m| estimate_message_tokens(m, self.config.reasoning_replay))
                    .fold(
                        estimate_text_tokens(system_prompt.unwrap_or("")),
                        u32::saturating_add,
                    )
                    .saturating_add(tools_tokens);
                // The assistant message just produced IS output — its
                // reasoning was generated and billed regardless of whether a
                // later request will replay it, so it counts as text here.
                let output =
                    estimate_message_tokens(&turn.assistant_message, ReasoningReplay::Text);
                effective_usage = TokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    // Marked at the source. This number drives a COST figure,
                    // and an estimate presented as measured is worse than no
                    // figure at all.
                    estimated: Some(true),
                    cost_usd: None,
                };
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::Usage(effective_usage.clone()),
                };
                seq = seq.saturating_add(1);
                let _ = event_sink.send(envelope).await;
            }

            let effective_usage_output = effective_usage.output_tokens;
            total_usage = sum_usage(total_usage, effective_usage.clone());

            // Stamp what this request actually cost, and which model ran it,
            // onto the message being persisted.
            //
            // Both matter for money. The adapter attaches whatever the provider
            // reported, so a no-usage provider used to persist ZEROS while the
            // live UI showed the estimate above — a reopened chat then totalled
            // $0.00, which reads as "this was free" rather than "this was never
            // measured". And a thread's model can change between turns, so a
            // total that sums tokens and prices them once at whatever model is
            // selected NOW is wrong for every call that ran under a different
            // one; recording the model per call is what lets the total be summed
            // as money, per model.
            let mut assistant_message = turn.assistant_message.clone();
            assistant_message.usage = Some(effective_usage);
            if !model.is_empty() {
                assistant_message.model = Some(model.clone());
            }
            // A message with no blocks must never enter history. It says
            // nothing, and on the next request it serializes as an assistant
            // turn with empty content — which Anthropic rejects outright. One
            // dropped response would otherwise leave a landmine in the
            // transcript that breaks every later turn in the thread.
            //
            // The usage is still counted above, because it was still billed.
            let produced_nothing = assistant_message.blocks.is_empty();
            if !produced_nothing {
                session.append_message(assistant_message.clone());
                assistant_messages.push(assistant_message);
            }

            // Nothing ran and nothing was written, so re-issuing the identical
            // request is safe — and it is exactly what the user was doing by
            // hand, several times a day, because a dropped response is
            // transient. Once only: a second empty reply is a real condition
            // to report, not a loop to spin in.
            if produced_nothing && !retried_empty_reply {
                retried_empty_reply = true;
                eprintln!(
                    "agent_runtime: provider returned no content blocks \
                     (output_tokens={effective_usage_output}); retrying once"
                );
                continue;
            }

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
                        model: None,
                    });
                }

                // `length` means the model was cut off mid-sentence by the
                // output cap, not that it finished. This used to end the
                // turn indistinguishably from a clean stop, so a truncated
                // answer looked like a complete one — the user's only clue
                // was prose that stopped mid-word. Say it out loud.
                if is_length_stop(&stop_reason) {
                    emit_truncation_notice(session, turn_id.as_str(), &mut seq, &event_sink).await;
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

            // ── Truncated tool batch ───────────────────────────────
            //
            // A `length` stop here means the output cap cut the assistant
            // message off *while it was emitting tool calls*. Two things are
            // wrong with running them anyway. The call the cut landed inside
            // may have arguments that parse but are silently incomplete (a
            // `file_write` missing the tail of its content is the nightmare
            // case), and every call the model meant to make after the cut is
            // simply absent — so the batch we hold is not the batch it asked
            // for. Fail all of them with an explanation the model can act on,
            // and stop the turn: the cap will truncate the retry exactly the
            // same way, so looping would only burn tokens. The user gets the
            // notice telling them to raise Max output.
            if is_length_stop(&turn.stop_reason) {
                stop_reason = turn.stop_reason.clone();
                let failed = self
                    .fail_pending_tool_calls(
                        &pending_tools,
                        TRUNCATED_CALL,
                        &turn_id,
                        &mut seq,
                        &event_sink,
                    )
                    .await;
                session.append_message(failed.clone());
                tool_results.push(failed);
                emit_truncation_notice(session, turn_id.as_str(), &mut seq, &event_sink).await;
                let _ = event_sink
                    .send(AgentEventEnvelope {
                        turn_id: turn_id.clone(),
                        seq,
                        event: AssistantEvent::MessageStop {
                            stop_reason: stop_reason.clone(),
                        },
                    })
                    .await;
                break;
            }

            // Cancel check between API call and tool execution — a
            // cancel arriving here saves us up to N tool dispatches.
            //
            // The assistant message carrying these `tool_use` blocks is
            // already in the session, and the turn epilogue persists on the
            // error path too. Returning without answering them would leave the
            // thread permanently malformed: every later prompt rebuilds a
            // request the provider rejects with a 400. Answer them first.
            if cancel_token.is_cancelled() {
                let cancelled = self
                    .fail_pending_tool_calls(
                        &pending_tools,
                        STOPPED_BEFORE_RUN,
                        &turn_id,
                        &mut seq,
                        &event_sink,
                    )
                    .await;
                session.append_message(cancelled);
                return Err(RuntimeError::Cancelled);
            }

            let batch = self
                .execute_tool_calls(
                    pending_tools,
                    session,
                    &turn_id,
                    &cancel_token,
                    &event_sink,
                    &mut seq,
                )
                .await?;

            // A cancel *inside* the batch keeps whatever finished: those
            // results are real, and the calls that never ran were answered
            // with `STOPPED_MID_RUN`. Persist the message before unwinding so
            // the pairing invariant holds.
            if batch.cancelled {
                session.append_message(batch.message.clone());
                tool_results.push(batch.message);
                return Err(RuntimeError::Cancelled);
            }

            let mut tool_msg = batch.message;

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
                // A composer mid-turn message gets the framing preamble so
                // the model knows it arrived while the tools above were
                // running — "don't run pnpm" landing after the lint output
                // is otherwise a contradiction the model has to guess at.
                let injected_text = if queued.mid_turn {
                    format!(
                        "{}\n{}",
                        crate::agent_runtime::session::MID_TURN_PREAMBLE,
                        queued.text
                    )
                } else {
                    queued.text.clone()
                };
                tool_msg.blocks.push(ContentBlock::Text {
                    text: injected_text,
                });
                // Composer pill metadata rides on the tool message itself, so
                // a reload can re-render the injected row's chips — the same
                // persistence channel a normal user message uses.
                tool_msg.attached_prompt_chips = queued.chips.clone();
                // The event carries the DISPLAY text: what the user typed,
                // not the model copy with the resolved directive block.
                let display = queued.display_text.unwrap_or(queued.text);
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::QueuedMessageInjected {
                        text: display,
                        chips: queued.chips,
                    },
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

    /// The part of every request that is not the transcript: the composed
    /// system prompt and the tool catalogue.
    ///
    /// Both ride on EVERY call and neither lives in the session, so a
    /// projection that counts only messages under-reports the request it is
    /// deciding about — on Aurora's toolset the schemas alone run to tens of
    /// thousands of tokens.
    /// Where the untruncated history for this session lives, when the model
    /// could actually open it.
    ///
    /// Compaction is lossy but not destructive — Aurora only ever shrinks the
    /// API view; the JSONL keeps everything. Telling the model where that file
    /// is turns "the summary dropped the detail I need" from a dead end into a
    /// `file_read`. Gated on `allow_outside_workspace` because the session
    /// store sits outside the project: without it the read is refused, and
    /// pointing the model at a path it cannot open is worse than staying quiet.
    fn transcript_hint(&self, session: &Session) -> Option<String> {
        if !self.config.allow_outside_workspace {
            return None;
        }
        let dir = self.store_dir.as_deref()?;
        Some(
            dir.join(format!("{}.jsonl", session.thread_id))
                .to_string_lossy()
                .into_owned(),
        )
    }

    /// The post-compaction message view this session would send right now.
    fn compacted_view(&self, session: &Session) -> Vec<ConversationMessage> {
        let hint = self.transcript_hint(session);
        apply_compaction(session.messages(), hint.as_deref())
    }

    /// Memoized: the catalogue is fixed for the runtime's lifetime, and this
    /// runs inside the tool loop. Re-serializing ~25 schemas to JSON and
    /// tokenizing tens of thousands of characters on every iteration is pure
    /// waste — the answer cannot change between them.
    fn fixed_request_overhead_tokens(&self) -> u32 {
        let schema_tokens = *self
            .tool_schema_tokens
            .get_or_init(|| estimate_tool_schema_tokens(&self.tools.schemas()));
        estimate_text_tokens(self.config.system_prompt.as_deref().unwrap_or(""))
            .saturating_add(schema_tokens)
    }

    /// Size of the request this session would produce right now — **the** one
    /// definition of "how full is the context", shared by the compaction
    /// trigger, `/compact`, and the number the UI shows.
    ///
    /// Anchored on measurement, not re-derived from disk. Aurora used to
    /// estimate the whole transcript from scratch every time, which meant every
    /// provider quirk it did not model — replayed reasoning, tool schemas,
    /// tokenizer differences, cache accounting — compounded into the answer.
    /// That is how a 180k context came to be reported as 431k.
    ///
    /// Instead: find the most recent request the PROVIDER measured, take its
    /// number, and estimate only the messages appended since. The measured
    /// anchor already contains the system prompt, the tool schemas and every
    /// unknowable, so error can never exceed the last few messages — it cannot
    /// accumulate across a long conversation.
    ///
    /// The from-scratch path survives as the fallback for the case it is
    /// actually right for: no request has been measured yet (a fresh session,
    /// a provider that reports no usage, or the first turn after a compaction
    /// dropped the anchor out of the view). Only there is the fixed overhead
    /// added by hand, because only there is it missing.
    fn projected_request_tokens(&self, session: &Session) -> u32 {
        let view = self.compacted_view(session);
        let replay = self.config.reasoning_replay;

        for (idx, message) in view.iter().enumerate().rev() {
            let Some(usage) = message.usage.as_ref() else {
                continue;
            };
            // Our own synthetic usage is an estimate wearing a measurement's
            // clothes — anchoring on it would launder a guess into "measured".
            if usage.estimated == Some(true) {
                continue;
            }
            let anchor = measured_context_tokens(usage);
            if anchor == 0 {
                continue;
            }
            return view[idx + 1..]
                .iter()
                .map(|m| estimate_message_tokens(m, replay))
                .fold(anchor, u32::saturating_add);
        }

        view.iter()
            .map(|m| estimate_message_tokens(m, replay))
            .fold(self.fixed_request_overhead_tokens(), u32::saturating_add)
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

        // Projected size of the request we're about to build (after any prior
        // compaction is applied). Compare against threshold% of the window.
        let projected = self.projected_request_tokens(session);
        let limit = (window as f32 * threshold) as u32;
        if projected < limit {
            return;
        }

        // Circuit breaker. A failed compaction does not fix the overrun that
        // called it, so without this the next turn crosses the same threshold
        // and pays for the same doomed request again, forever — the single
        // most expensive request in the chat, on repeat, behind a spinner.
        let now = Utc::now().timestamp_millis();
        if session.compaction_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES {
            match session.compaction_retry_after {
                Some(retry_at) if now < retry_at => return,
                // Cooldown served: clear the strikes and allow one more try.
                _ => {
                    session.compaction_failures = 0;
                    session.compaction_retry_after = None;
                }
            }
        }

        match self
            .compact_inner(session, turn_id, seq, event_sink, cancel_token)
            .await
        {
            CompactionOutcome::Compacted { .. } => {
                session.compaction_failures = 0;
                session.compaction_retry_after = None;
            }
            CompactionOutcome::SummaryFailed => {
                session.compaction_failures = session.compaction_failures.saturating_add(1);
                if session.compaction_failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES {
                    session.compaction_retry_after = Some(now + COMPACTION_FAILURE_COOLDOWN_MS);
                    eprintln!(
                        "agent_runtime: compaction failed {} times for thread {}; \
                         pausing auto-compaction for {} minutes (trim still bounds the request)",
                        session.compaction_failures,
                        session.thread_id,
                        COMPACTION_FAILURE_COOLDOWN_MS / 60_000,
                    );
                }
            }
            // Nothing was attempted and nothing was spent — a transcript too
            // short to cut is not a failure, and counting it as one would use
            // up the budget meant for real ones.
            CompactionOutcome::NothingToDo => {}
        }
    }

    /// Force a compaction pass immediately, bypassing the configured threshold.
    /// Returns the before/after token estimate when a marker was persisted.
    ///
    /// A manual `/compact` deliberately ignores the auto-compaction circuit
    /// breaker: the user asked for this one, and is watching it.
    pub async fn compact_now(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
    ) -> Option<(u32, u32)> {
        match self
            .compact_inner(session, turn_id, seq, event_sink, cancel_token)
            .await
        {
            CompactionOutcome::Compacted { before, after } => Some((before, after)),
            _ => None,
        }
    }

    /// The compaction pass itself. Reports WHY it produced no marker, which
    /// [`Self::maybe_compact`]'s breaker needs: "the transcript was too short"
    /// cost nothing and must not count against the retry budget, while "the
    /// summarizer failed" cost a full-history request and must.
    async fn compact_inner(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
    ) -> CompactionOutcome {
        let Some(window) = self.config.context_window else {
            return CompactionOutcome::NothingToDo;
        };
        if window == 0 {
            return CompactionOutcome::NothingToDo;
        }

        let projected = self.projected_request_tokens(session);

        // A user-boundary cut preserving at most `compact_tail_budget` tokens
        // verbatim. `None` => transcript too short to compact safely.
        let Some(cut) = compaction_cut(session.messages(), window, self.config.reasoning_replay)
        else {
            return CompactionOutcome::NothingToDo;
        };

        // Signal the UI: ring → spinner, live shimmer card.
        emit_native_tool_event(event_sink, turn_id, seq, AssistantEvent::CompactionStarted).await;

        // Summarize the head (everything older than the cut). Any prior marker
        // in the head is folded to its summary first, so we never re-feed a
        // raw marker to the summarizer.
        // No resume note on the head: this slice is being READ by the
        // summarizer, not resumed from. "Pick up where you left off"
        // would be an instruction aimed at the wrong request.
        let head_view = apply_compaction(&session.messages()[..cut], None);
        let model = session.model.clone();
        let summarized = self.summarize_head(&head_view, &model, cancel_token).await;
        let summary_usage = summarized.as_ref().map(|(_, usage)| usage.clone());

        let summary = match summarized {
            Some((s, _)) if !s.trim().is_empty() => s,
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
                return CompactionOutcome::SummaryFailed;
            }
        };

        // After-size = the same fixed overhead the projection used (system
        // prompt + tool schemas) + summary + the verbatim tail kept from
        // `cut`. Both numbers must be built the same way or the card reports
        // a drop the request never made.
        let tail_tokens = session.messages()[cut..]
            .iter()
            .map(|m| estimate_message_tokens(m, self.config.reasoning_replay))
            .fold(0u32, u32::saturating_add);
        let after = self
            .fixed_request_overhead_tokens()
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
            // What the summarization request itself cost, attributed to the
            // model that ran it. Carried on the marker because that is the
            // only message this request produces — without it the charge
            // exists on the bill and nowhere in Aurora.
            usage: summary_usage,
            timestamp: now,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            // The model that ran the SUMMARY, which is not the chat model once
            // a compaction model is pinned. The cost card groups by this field
            // to price a mixed-model chat at each model's own rates — naming
            // the chat model here would bill a cheap summarizer's tokens at the
            // expensive model's rate.
            model: self
                .compaction_client
                .as_ref()
                .map(|(_, m)| m.clone())
                .or_else(|| model.clone()),
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

        CompactionOutcome::Compacted {
            before: projected,
            after,
        }
    }

    /// Summarize the head, sharing the conversation's prompt cache when that
    /// is possible.
    ///
    /// **This is where most of compaction's cost is decided**, and the deciding
    /// factor is not which model runs it — it is whether the request reuses a
    /// prefix the provider has already cached.
    ///
    /// The cache key is the whole prefix: model, system prompt, tools, message
    /// prefix, and thinking config. The head IS a prefix of the conversation,
    /// so a request that keeps the other four identical reads ~200k tokens at
    /// the cache rate — typically a tenth of fresh input — and the compaction
    /// instruction rides on the end, past the cached region, where it costs
    /// almost nothing. Changing the system prompt or dropping the tools (which
    /// is what this used to do) diverges the prefix at token zero and throws
    /// that away: the same model, on the same history, billed in full.
    ///
    /// The corollary matters when picking a compaction model: a pinned model
    /// has no cache to share, so it pays fresh input for the entire head. It is
    /// cheaper than the chat model only if its fresh rate beats the chat
    /// model's CACHE rate — roughly a tenth of the chat model's list price, not
    /// merely less than it.
    ///
    /// Returns the note AND what producing it cost — this request carries the
    /// whole head, so it is routinely the largest single charge in a long chat,
    /// and it produces no assistant message to hang usage on.
    async fn summarize_head(
        &self,
        head_view: &[ConversationMessage],
        model: &Option<String>,
        cancel_token: &CancellationToken,
    ) -> Option<(String, TokenUsage)> {
        // Only the conversation's own client can hit the conversation's cache.
        if self.compaction_client.is_none() {
            let shared = self
                .summarize_with(head_view, model, cancel_token, true)
                .await;
            // Advertising the tools is what preserves the cache key, and the
            // price of that is a model that occasionally answers with a tool
            // call instead of the note. Rather than let a formatting accident
            // burn a compaction attempt, fall back to the standalone shape —
            // which cannot be misread, only re-billed.
            if shared.as_ref().is_some_and(|(s, _)| !s.trim().is_empty()) {
                return shared;
            }
            eprintln!(
                "agent_runtime: cache-sharing summary came back empty; \
                 retrying without the tool catalogue"
            );
        }
        self.summarize_with(head_view, model, cancel_token, false)
            .await
    }

    /// One summarization attempt.
    ///
    /// `share_cache` picks between the two request shapes:
    ///
    /// - **true** — mirror the conversation's own request exactly (its system
    ///   prompt, its tools, its thinking config, reasoning left in place) so
    ///   the prefix matches and the head is billed at the cache rate. The
    ///   entire instruction moves into the trailing user message, past the
    ///   cached region.
    /// - **false** — the cache cannot hit, so send the smallest, most portable
    ///   request instead: dedicated system prompt, no tools, thinking off, and
    ///   reasoning stripped (a signature from one provider is meaningless to
    ///   another, and this request runs with thinking disabled).
    async fn summarize_with(
        &self,
        head_view: &[ConversationMessage],
        model: &Option<String>,
        cancel_token: &CancellationToken,
        share_cache: bool,
    ) -> Option<(String, TokenUsage)> {
        // A pinned compaction model brings its own client; otherwise the
        // summary rides the conversation's provider and model.
        let (client, model) = match &self.compaction_client {
            Some((client, model)) => (client.clone(), model.clone()),
            None => (self.api_client.clone(), model.clone().unwrap_or_default()),
        };
        if model.is_empty() {
            return None;
        }

        // Reasoning is kept when sharing the cache — removing it would alter
        // the prefix and cost far more than it saves — and stripped otherwise,
        // where it is unusable weight.
        let head = if share_cache {
            head_view.to_vec()
        } else {
            strip_reasoning(head_view.to_vec())
        };

        // The head is an arbitrary slice of the conversation, so the cut can
        // land between a tool call and its result — and the head may already
        // contain an unanswered call from an earlier stopped turn. Either way
        // the provider rejects this request, the summary comes back `None`,
        // and compaction silently never happens: the context grows until the
        // real turn starts failing too. Repair the same way the turn request
        // does. Runs last so it sees the shape actually being sent.
        let mut messages = repair_tool_pairing(head).messages;

        // The trailing instruction. When sharing the cache it carries the
        // whole prompt (the system slot belongs to the conversation and must
        // not change) plus the no-tools warning that the advertised catalogue
        // makes necessary.
        let instruction = if share_cache {
            format!("{COMPACTION_NO_TOOLS_PREAMBLE}\n\n{COMPACTION_SYSTEM_PROMPT}\n\n{COMPACTION_INSTRUCTION}")
        } else {
            COMPACTION_INSTRUCTION.to_string()
        };
        messages.push(ConversationMessage {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: instruction }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        });

        let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

        let schemas = if share_cache {
            self.tools.schemas()
        } else {
            Vec::new()
        };
        let request = ApiRequest {
            model: &model,
            system_prompt: if share_cache {
                self.config.system_prompt.as_deref()
            } else {
                Some(COMPACTION_SYSTEM_PROMPT)
            },
            messages: &messages,
            tools: &schemas,
            // Temperature is not part of the cache key, so a low one is free
            // either way.
            temperature: Some(0.3),
            max_output_tokens: self.config.compaction_summary_budget,
            // Thinking config IS part of the cache key. When sharing, it has to
            // match the conversation's or the prefix is invalidated and the
            // whole exercise is pointless. Standalone, it stays off —
            // summarizing must never spend the user's reasoning budget.
            thinking_enabled: share_cache && self.config.thinking_enabled,
            thinking_budget_tokens: if share_cache {
                self.config.thinking_budget_tokens
            } else {
                None
            },
        };
        let result = client.stream(request, tx, cancel_token.clone()).await;
        let _ = drain.await;

        match result {
            // Strip the `<analysis>` scratchpad here, at the boundary, so the
            // drafting pass costs output tokens once and never enters context.
            Ok(turn) => Some((
                format_compact_summary(&collect_assistant_text(&turn.assistant_message)),
                turn.usage,
            )),
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
    ) -> Result<ToolBatchOutcome, RuntimeError> {
        let mut result_blocks = Vec::with_capacity(calls.len());
        // Set when a tool reports `ToolError::Cancelled`. The batch is not
        // abandoned at that point: results that already landed are real work
        // worth keeping, and — decisively — every call in the assistant
        // message still needs an answer or the thread is malformed for good.
        let mut cancelled = false;
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
                    // The very directory `spill_tool_output` writes to, so a
                    // spilled result's path is readable by the agent that just
                    // produced it — see `ToolContext::spill_dir`.
                    spill_dir: self.store_dir.as_deref().map(|root| {
                        super::session_store::tool_results_dir_in(root, &session.thread_id)
                    }),
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

                // A cancelled tool ends the turn, but it does not get to skip
                // its result block — see `cancelled` above.
                if matches!(&outcome, Err(ToolError::Cancelled)) {
                    cancelled = true;
                    if !uses_frontend_lifecycle {
                        emit_native_tool_event(
                            event_sink,
                            turn_id,
                            seq,
                            AssistantEvent::ToolExecutionResult {
                                id: id.clone(),
                                name,
                                input,
                                content: STOPPED_MID_RUN.to_string(),
                                is_error: true,
                            },
                        )
                        .await;
                    }
                    result_blocks.push(ContentBlock::ToolResult {
                        tool_use_id: id,
                        content: STOPPED_MID_RUN.to_string(),
                        is_error: Some(true),
                    });
                    continue;
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

            if cancelled {
                break;
            }
        }

        // Calls from batches that were never dispatched. `cursor` already
        // points past the last batch that ran, so this is exactly the tail the
        // cancellation cut off. They still need answers.
        if cancelled && cursor < calls.len() {
            let skipped = &calls[cursor..];
            let pending = self
                .fail_pending_tool_calls(skipped, STOPPED_BEFORE_RUN, turn_id, seq, event_sink)
                .await;
            result_blocks.extend(pending.blocks);
        }

        Ok(ToolBatchOutcome {
            message: ConversationMessage {
                role: MessageRole::Tool,
                blocks: result_blocks,
                usage: None,
                timestamp: Utc::now().timestamp_millis(),
                attached_selected_elements: None,
                attached_prompt_chips: None,
                model: None,
            },
            cancelled,
        })
    }

    /// Answer a batch of tool calls that were never executed.
    ///
    /// Emits the start/result event pair for each (so its card resolves with
    /// the reason instead of spinning forever) and returns the `Tool` message
    /// that keeps the conversation well-formed. Tools that own their own
    /// frontend lifecycle are left to it, matching `execute_tool_calls`.
    async fn fail_pending_tool_calls(
        &self,
        calls: &[PendingToolCall],
        reason: &str,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
    ) -> ConversationMessage {
        for call in calls {
            let uses_frontend_lifecycle = self
                .tools
                .get(&call.name)
                .is_some_and(|executor| executor.uses_frontend_lifecycle());
            if uses_frontend_lifecycle {
                continue;
            }
            // `tool_execution_start` is what guarantees the card exists — the
            // frontend treats its `onToolCall` as idempotent precisely so a
            // native tool can announce itself late. Skipping straight to the
            // result would leave nothing to resolve.
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
            emit_native_tool_event(
                event_sink,
                turn_id,
                seq,
                AssistantEvent::ToolExecutionResult {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    content: reason.to_string(),
                    is_error: true,
                },
            )
            .await;
        }

        let ids: Vec<String> = calls.iter().map(|call| call.id.clone()).collect();
        synthetic_tool_results(&ids, reason)
    }
}

/// One tool batch's worth of results, plus whether a cancellation cut it short.
///
/// The message is always complete — every call in it has a result block, real
/// or synthetic — so the caller can persist it before unwinding.
struct ToolBatchOutcome {
    message: ConversationMessage,
    cancelled: bool,
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

/// Tell the user (and the reloaded thread) that the reply was cut off by the
/// model's output cap.
///
/// Fires on BOTH length-stop paths — the reply that ended mid-sentence, and the
/// one that was cut while emitting tool calls. The second used to say nothing at
/// all: the tool batch was executed as if the model had finished asking for it,
/// so the only symptom was an agent that quietly did part of a job.
async fn emit_truncation_notice(
    session: &mut Session,
    turn_id: &str,
    seq: &mut u64,
    event_sink: &mpsc::Sender<AgentEventEnvelope>,
) {
    // Plain text: this renders in an inline notice marker, not through the
    // markdown pipeline, so backticks would show up literally.
    const TRUNCATED_NOTICE: &str =
        "This reply is cut off — the model reached its output limit. Raise Max \
         output for this model in provider settings, or ask it to continue.";

    *seq += 1;
    let _ = event_sink
        .send(AgentEventEnvelope {
            turn_id: turn_id.to_string(),
            seq: *seq,
            event: AssistantEvent::Error {
                message: TRUNCATED_NOTICE.to_string(),
                recoverable: true,
            },
        })
        .await;

    // Persist it too. The event alone only reaches the window that is open now;
    // without a session record, reopening the thread shows the truncated reply
    // with no explanation for why it stops mid-sentence. Appended AFTER the
    // assistant message so it reloads directly beneath it.
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
        model: None,
    });
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

/// Strip the `oldContent`/`newContent` echo out of a modify-family result
/// before it enters MODEL history. Both strings are content the model itself
/// just sent (or read moments ago); echoing them back burned most of the 8 KiB
/// cap per edit on pure duplication — the loudest silent context cost in the
/// toolset. The counts and message that remain are the actual signal, and the
/// model can always `file_read` to verify. The UI is unaffected: the live tool
/// card gets its own untouched copy, and reload-time diffs come from the
/// `.rich.jsonl` sidecar.
///
/// Returns `None` when the result carries no echo (failures, non-JSON), in
/// which case the caller leaves the content as it was.
fn strip_edit_content_echo(raw: &str) -> Option<String> {
    let mut value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let mut stripped_any = false;

    let mut strip = |obj: &mut serde_json::Map<String, serde_json::Value>| {
        for key in ["oldContent", "newContent"] {
            if obj.remove(key).is_some() {
                stripped_any = true;
            }
        }
    };

    if let serde_json::Value::Object(map) = &mut value {
        strip(map);
        if let Some(serde_json::Value::Array(files)) = map.get_mut("files") {
            for entry in files.iter_mut() {
                if let serde_json::Value::Object(file) = entry {
                    strip(file);
                }
            }
        }
        if stripped_any {
            // Name the elision and its recovery, so absence reads as policy
            // rather than as a tool that forgot to report what it wrote.
            map.insert(
                "contentEcho".into(),
                serde_json::Value::String(
                    "elided from history — the edit applied as sent; file_read the path to verify"
                        .into(),
                ),
            );
        }
    }

    stripped_any.then(|| serde_json::to_string(&value).ok())?
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
    //
    // The check is a VALIDATED parse, not a substring test. Text that merely
    // quotes the marker syntax (this project's own docs and source do) used to
    // take this branch, so it skipped the cap below AND was handed to the
    // provider adapter as an image — prose shipped as base64, HTTP 400.
    if crate::api::aurora_image::has_marker(&s) {
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
    // Modify-family results drop their before/after echo from the model copy
    // regardless of size — see `strip_edit_content_echo`. Done before the cap
    // so the budget is never spent shrinking content the model already has.
    let s = if rich_persisted_tool(tool) {
        strip_edit_content_echo(&s).unwrap_or(s)
    } else {
        s
    };
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
    let Some(marker) = crate::api::aurora_image::find_marker(s, 0) else {
        return s.to_string();
    };

    let path = marker.src().map(|v| unescape_xml_attr(v.to_string()));
    let width = marker.attr("width").and_then(|v| v.parse::<u64>().ok());
    let height = marker.attr("height").and_then(|v| v.parse::<u64>().ok());

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
    use crate::api::aurora_image::{find_marker, CLOSE};

    let mut out = String::with_capacity(s.len());
    let mut cursor = 0usize;
    while let Some(marker) = find_marker(s, cursor) {
        // Text before + the full header incl. '>'.
        out.push_str(&s[cursor..marker.header_end]);
        if marker.src().is_none() {
            // No disk copy → keep the body so the image survives.
            out.push_str(marker.body);
        }
        // else: drop the base64 body — rehydratable from disk.
        out.push_str(CLOSE);
        cursor = marker.end;
    }
    out.push_str(&s[cursor..]);
    out
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

/// How much recent conversation survives a compaction, word for word.
/// Everything older is replaced by the summary.
///
/// An ABSOLUTE token count, and deliberately not a fraction of the context
/// window. It used to be 30% of the window, which reads as reasonable at 200k
/// (a 60k tail) and is indefensible at 1.1M, where it authorises a 330k tail —
/// a real chat compacted a 382k request down to 204k and reported that as
/// done. Nothing was broken in the arithmetic; the budget was simply enormous.
///
/// What the model needs in front of it to resume is a property of the WORK,
/// not of the window the work happens to be running in. A 1M-context model
/// does not need six times more recent history than a 200k one to pick up
/// where it left off — it just tolerates the waste for longer, silently, at
/// full price on every subsequent request.
///
/// `openclaude` reached the same conclusion and every budget it carries is a
/// number rather than a ratio: its preserved segment caps at 40k, post-compact
/// file restore at 50k, skills at 25k, the auto-compact buffer at 30k. Its
/// standard `/compact` keeps no verbatim tail at all.
const COMPACT_TAIL_MAX_TOKENS: u32 = 40_000;

/// Ceiling on the tail as a share of the window, for models where
/// [`COMPACT_TAIL_MAX_TOKENS`] would be most of the context (or more than all
/// of it). A 32k model gets an 8k tail; every model at 160k and up gets the
/// full 40k. This is the only place the window still has a say, and it can
/// only ever make the budget SMALLER.
const COMPACT_TAIL_WINDOW_DIVISOR: u32 = 4;

/// The verbatim-tail budget for a given window: at most
/// [`COMPACT_TAIL_MAX_TOKENS`], and never more than a quarter of the window.
fn compact_tail_budget(window: u32) -> u32 {
    COMPACT_TAIL_MAX_TOKENS.min(window / COMPACT_TAIL_WINDOW_DIVISOR)
}

/// System prompt for the summarization call. Drives an LLM summary (not a
/// deterministic template) — fidelity over a generous budget is the whole
/// point of compaction over plain trimming.
/// The summarization prompt.
///
/// Written in the SECOND PERSON on purpose. This is not a report about a
/// conversation for some other reader — it is a note the model writes to
/// itself, moments before everything it is looking at disappears. Everything
/// it fails to write down is gone, and the user will carry on as if nothing
/// happened. Framing it as "summarize this transcript" produced detached
/// third-person recaps; framing it as "this is all you will have left"
/// produces the specifics that actually let work resume.
///
/// The `<analysis>` block is a drafting scratchpad — a chronological pass
/// before compression, which is where recency bias and dropped user
/// corrections otherwise creep in. [`format_compact_summary`] strips it, so it
/// costs output tokens but never context. It is also how this call gets
/// chain-of-thought without extended thinking, which stays off (compaction
/// must never spend the user's reasoning budget).
///
/// Section 6 — every user message — is the one that matters most and is the
/// easiest to lose: the user's own words ARE the intent, and a paraphrase of
/// "actually, do it the other way" is worth nothing.
const COMPACTION_SYSTEM_PROMPT: &str = r#"You are writing the memory of this conversation.

Everything above is about to be removed and replaced by exactly what you write now. Work resumes immediately afterward from your note alone, with a user who saw no interruption and expects every detail to still be known. Anything you leave out is gone for good.

Write the note you would want to find.

First, in <analysis> tags, work through the conversation in order. For each part, identify:
- what the user asked for, in their words
- what you did about it, and why
- decisions you made, alternatives you rejected, and the reasoning
- concrete details: file paths, function signatures, full code snippets, exact commands
- errors you hit and how you resolved them
- any point where the user corrected you or told you to do something differently — these matter more than anything else here

Then, in <summary> tags, write the note itself under these headings:

1. Primary request and intent — everything the user has asked for, in detail.
2. Key technical context — the systems, frameworks, and constraints in play.
3. Files and code — every file you read, created, or changed. Give the path, why it matters, and the code that will be needed again. Weight the most recent work heavily.
4. Errors and fixes — what went wrong, what fixed it, and what the user said about it.
5. Problem solving — what is resolved and what is still being worked out.
6. Every user message — list all of the user's own messages (not tool results), in order. Their exact words are the requirements; do not compress them into themes.
7. Standing instructions — preferences and constraints the user has stated that still apply.
8. Pending tasks — what you were explicitly asked to do that is not done.
9. Current work — precisely what you were doing immediately before this, with file names and code.
10. Next step — the single next action, and only if it follows directly from the most recent request. Quote the relevant part of the conversation verbatim so the task cannot drift. If the work was finished, say so instead of inventing a next step.

Be specific. Exact names, exact paths, exact values. A detail you generalize away is a detail you will have to rediscover.

Respond with text only. Do not call tools. Do not address the user."#;

/// Placed FIRST in the trailing message on the cache-sharing path.
///
/// Keeping the tool catalogue is what preserves the cache key, but a model
/// handed tools will sometimes reach for one instead of answering — and this
/// request gets a single turn, so a tool call means no note at all. Stated up
/// front, and in terms of the consequence, because a warning buried under a
/// thousand words of instructions is a warning the model has already scrolled
/// past.
const COMPACTION_NO_TOOLS_PREAMBLE: &str = "CRITICAL: answer with text only. Do NOT call any tool — not to read a file, not to check anything. You already have everything you need above, this is your only turn, and a tool call will waste it and lose the note entirely.";

/// Trailing user instruction appended to the head when requesting the summary.
const COMPACTION_INSTRUCTION: &str =
    "Write your handoff note for the conversation above, following your instructions: an <analysis> block, then a <summary> block. Nothing else.";

/// Drop every reasoning block from a slice of history.
///
/// Applied to the head before it is handed to the summarizer, for three
/// reasons that all point the same way:
///
/// 1. **It is not the record.** What happened is the text and the tool calls.
///    Reasoning is how the model got there, and a note about the work does not
///    need the deliberation behind it.
/// 2. **It is the bulk of the payload.** Stored reasoning — the encrypted
///    Responses-API items especially — ran to 22.7% of one real transcript.
///    Compaction is already the single largest request a chat makes; sending
///    it the reasoning too is paying a premium for noise.
/// 3. **It does not travel.** A `signature` is issued by one provider and
///    meaningless to another, and the summarization request runs with thinking
///    OFF — yet the Anthropic converter emits `thinking` blocks regardless.
///    Left in, a chat with reasoning history summarized on a different
///    provider fails on every attempt.
///
/// Messages emptied by the strip are dropped: a reasoning-only assistant
/// message leaves nothing behind, and providers reject empty content. Nothing
/// carrying a tool call can be emptied this way, so pairing is untouched.
fn strip_reasoning(messages: Vec<ConversationMessage>) -> Vec<ConversationMessage> {
    messages
        .into_iter()
        .filter_map(|mut message| {
            message
                .blocks
                .retain(|b| !matches!(b, ContentBlock::Thinking { .. }));
            (!message.blocks.is_empty()).then_some(message)
        })
        .collect()
}

/// Reduce a raw summarization response to the note itself.
///
/// Drops the `<analysis>` scratchpad (it did its job improving the summary and
/// has no value once written — keeping it would spend context on the model's
/// own drafting) and unwraps `<summary>`. A response that used neither tag is
/// returned trimmed: the tags are a request, not a guarantee, and a summary
/// that arrived in the wrong shape is still worth infinitely more than
/// discarding it and failing the compaction.
fn format_compact_summary(raw: &str) -> String {
    let without_analysis = match raw.find("<analysis>") {
        Some(start) => {
            // Where the scratchpad ends: its closing tag, or — when the model
            // forgot to close it — the start of the summary, which is the
            // other unambiguous boundary. Taking only the closing tag would
            // throw away a summary that WAS written, turning a formatting slip
            // into a failed compaction.
            let close = raw[start..]
                .find("</analysis>")
                .map(|i| start + i + "</analysis>".len());
            let summary_start = raw[start..].find("<summary>").map(|i| start + i);
            let resume = match (close, summary_start) {
                (Some(c), Some(s)) => Some(c.min(s)),
                (Some(c), None) => Some(c),
                (None, Some(s)) => Some(s),
                // Neither: the response was cut off mid-draft and there is
                // nothing after the scratchpad to keep.
                (None, None) => None,
            };
            let mut out = String::with_capacity(raw.len());
            out.push_str(&raw[..start]);
            if let Some(resume) = resume {
                out.push_str(&raw[resume..]);
            }
            out
        }
        None => raw.to_string(),
    };

    match (
        without_analysis.find("<summary>"),
        without_analysis.find("</summary>"),
    ) {
        (Some(start), Some(end)) if end > start => without_analysis[start + "<summary>".len()..end]
            .trim()
            .to_string(),
        // Opened but never closed — the budget ran out mid-note. Keep what
        // was written; a truncated note still carries the early sections.
        (Some(start), None) => without_analysis[start + "<summary>".len()..]
            .trim()
            .to_string(),
        _ => without_analysis.trim().to_string(),
    }
}

/// The block that replaces the summarized history in the model's view.
///
/// Two jobs beyond carrying the summary. It tells the model what it is
/// looking at — its own note, not source material, with the verbatim tail
/// still intact below — and it tells the model how to behave, which is the
/// part that actually shows: the user experienced no break, so an assistant
/// that opens with "based on the summary of our earlier conversation" has
/// leaked an implementation detail and broken the thread. Continuity is the
/// deliverable.
///
/// `transcript_hint` is a lifeline, not decoration: the full history is still
/// on disk, so an exact snippet the note generalized away is recoverable —
/// and only offered when the model can actually read it.
fn compaction_preamble(summary: &str, transcript_hint: Option<&str>) -> String {
    let mut out = String::with_capacity(summary.len() + 700);
    out.push_str(
        "<conversation_summary>\n\
         This conversation is continuing from earlier work that no longer fits in context. \
         What follows is the record of that work — it is all that remains of it. \
         Everything after this block is preserved word for word.\n\n",
    );
    out.push_str(summary);
    out.push_str("\n</conversation_summary>\n\n");
    out.push_str(
        "Pick up exactly where you left off. The user saw no interruption and expects you to \
         remember all of this, so do not mention the summary, do not recap, do not re-introduce \
         yourself, and do not ask what you were working on. Treat everything above as your own \
         memory of the work.",
    );
    if let Some(path) = transcript_hint {
        out.push_str(&format!(
            " If you need an exact detail the note did not keep — a code snippet, an error string, \
             something you wrote earlier — the complete history is at {path}; read it with \
             file_read or search it with grep rather than guessing or asking the user to repeat \
             themselves.",
        ));
    }
    out
}

/// Build the model API view for a session that may carry compaction markers.
///
/// Replaces everything at or older than the LAST `ContentBlock::Compaction`
/// with its summary — folded onto the first user message of the verbatim tail
/// so the sequence stays user-led and valid for every provider — and keeps the
/// tail unchanged. A session with no marker round-trips unchanged. The
/// persisted JSONL is never touched; this is an API-view transform, exactly
/// like `inject_ide_context`/`trim_to_budget`, but summary-backed.
fn apply_compaction(
    messages: &[ConversationMessage],
    transcript_hint: Option<&str>,
) -> Vec<ConversationMessage> {
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
    let preamble = compaction_preamble(&summary, transcript_hint);

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
                    model: None,
                },
            );
        }
    }
    out
}

/// Pick the message index to cut at when compacting: the OLDEST `User`
/// boundary whose verbatim tail still fits [`compact_tail_budget`]
/// (maximising preserved recent context up to the cap). Falls back to the
/// newest user boundary that still leaves a non-empty head if even the last
/// turn exceeds the cap. Returns `None` when no safe cut exists (fewer than
/// two user turns) so the caller skips compaction.
///
/// The budget is an absolute token count — see [`COMPACT_TAIL_MAX_TOKENS`]
/// for why it must not scale with the window.
fn compaction_cut(
    messages: &[ConversationMessage],
    window: u32,
    replay: ReasoningReplay,
) -> Option<usize> {
    let target = compact_tail_budget(window);
    let per: Vec<u32> = messages
        .iter()
        .map(|m| estimate_message_tokens(m, replay))
        .collect();
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
    replay: ReasoningReplay,
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
    let per_msg_tokens: Vec<u32> = messages
        .iter()
        .map(|m| estimate_message_tokens(m, replay))
        .collect();
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
    use crate::api::aurora_image::find_marker;

    let mut images: u32 = 0;
    let mut stripped = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(marker) = find_marker(text, cursor) {
        stripped.push_str(&text[cursor..marker.start]);
        images = images.saturating_add(1);
        cursor = marker.end;
    }
    if images == 0 {
        return estimate_text_tokens(text);
    }
    stripped.push_str(&text[cursor..]);
    estimate_text_tokens(&stripped).saturating_add(images.saturating_mul(IMAGE_TOKEN_ESTIMATE))
}

/// Ciphertext characters per token of the reasoning an encrypted item stands
/// for.
///
/// A Responses-API reasoning item is replayed as an opaque
/// `encrypted_content` blob, and the provider bills it as the reasoning that
/// was encrypted — so its price is a property of the PLAINTEXT, which the
/// blob has inflated twice over: authenticated encryption adds an IV, a tag
/// and block padding, then base64 adds another 4/3. Running tiktoken over the
/// base64 instead (the old behaviour) charges roughly one token per two
/// characters and lands ~2.6× high.
///
/// Working backwards: ~4 plaintext chars per token, ~1.4× for the envelope and
/// base64 → ~5.5 ciphertext chars per real token. Rounded DOWN to 5, which
/// errs slightly high on purpose: over-counting compacts a little early, while
/// under-counting overruns the window and the provider rejects the turn.
const ENCRYPTED_REASONING_CHARS_PER_TOKEN: usize = 5;

/// Token cost of a replayed encrypted reasoning item, from its stored
/// signature. `None`/empty (a provider that gave us no item to replay) costs
/// nothing — there is no block to send.
fn estimate_encrypted_reasoning_tokens(signature: Option<&str>) -> u32 {
    let Some(sig) = signature.filter(|s| !s.is_empty()) else {
        return 0;
    };
    u32::try_from(sig.len() / ENCRYPTED_REASONING_CHARS_PER_TOKEN).unwrap_or(u32::MAX)
}

/// Why a compaction pass produced (or did not produce) a marker.
///
/// The distinction the circuit breaker turns on: only [`Self::SummaryFailed`]
/// spent money.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompactionOutcome {
    /// A marker was inserted. `before`/`after` are the projected request sizes
    /// either side of it.
    Compacted { before: u32, after: u32 },
    /// The summarization request ran and came back empty or errored. History
    /// is untouched and the overrun that triggered this is still there.
    SummaryFailed,
    /// Compaction was disabled, or the transcript had no safe cut. No request
    /// was made.
    NothingToDo,
}

/// Failed compactions tolerated before auto-compaction pauses for
/// [`COMPACTION_FAILURE_COOLDOWN_MS`].
///
/// Three, because the failures worth retrying are transient (a rate limit, a
/// dropped connection) and clear in one or two turns; the ones that are not
/// — a head too large for the summarizer's own window, a malformed history
/// the provider rejects — will never clear, and each attempt re-sends the
/// whole conversation.
const MAX_CONSECUTIVE_COMPACTION_FAILURES: u32 = 3;

/// How long auto-compaction stays paused after hitting the failure ceiling.
/// Long enough that a stuck conversation stops burning money, short enough
/// that a transient outage recovers without the user restarting anything.
/// Manual `/compact` is never blocked by this.
const COMPACTION_FAILURE_COOLDOWN_MS: i64 = 5 * 60 * 1000;

/// How much of the context window one measured request occupied.
///
/// Every slice of the prompt, plus the completion — because the assistant's
/// output is re-sent as input on the very next request, so a window that looks
/// comfortable without it is not. The three input fields are disjoint by
/// construction: Anthropic reports fresh, cache-write and cache-read
/// separately, and Aurora's OpenAI adapter subtracts the cache hit out of
/// `prompt_tokens` so the same addition holds there.
///
/// Missing `cache_creation_input_tokens` from this sum is not a rounding
/// error: on a cache-writing turn it is most of the prompt.
fn measured_context_tokens(usage: &TokenUsage) -> u32 {
    usage
        .input_tokens
        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0))
        .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
        .saturating_add(usage.output_tokens)
}

/// Token cost of the tool catalogue as the provider receives it.
///
/// Counted separately from the messages because the schemas are not part of
/// the transcript, yet they ride on EVERY request — on Aurora's toolset they
/// are tens of thousands of tokens. Leaving them out of the compaction
/// projection made it under-report the request it was deciding about, in the
/// opposite direction to the thinking-block over-count above; two errors of
/// opposite sign meant the number could not be trusted at any size.
fn estimate_tool_schema_tokens(schemas: &[ToolSchema]) -> u32 {
    schemas
        .iter()
        .map(|t| {
            estimate_text_tokens(&t.name)
                .saturating_add(estimate_text_tokens(&t.description))
                .saturating_add(estimate_text_tokens(&t.input_schema.to_string()))
        })
        .fold(0u32, u32::saturating_add)
}

/// Estimate the token cost of one [`ConversationMessage`].
///
/// Sums every block's textual content plus a small per-message and
/// per-block overhead matching the heuristic the legacy
/// `context::manager::ContextManager::count_round_tokens` uses (so the
/// trim's view of "how big is this turn" lines up with what the chat
/// indicator displayed under the old engine).
fn estimate_message_tokens(message: &ConversationMessage, replay: ReasoningReplay) -> u32 {
    let mut total: u32 = 4; // per-message overhead
    for block in &message.blocks {
        match block {
            ContentBlock::Text { text } => {
                // Excludes embedded image base64 (counts each image as a flat
                // estimate) so a pasted image doesn't read as ~100× its real
                // token cost.
                total = total.saturating_add(estimate_text_with_images(text));
            }
            // Priced by what the PROVIDER will do with it, not by what we
            // stored. See `ReasoningReplay` — for most providers the answer
            // is "nothing", and the stored bytes are pure phantom context.
            ContentBlock::Thinking {
                text, signature, ..
            } => match replay {
                ReasoningReplay::Dropped => {}
                ReasoningReplay::Text => {
                    total = total.saturating_add(estimate_text_tokens(text));
                }
                ReasoningReplay::Opaque => {
                    total = total
                        .saturating_add(estimate_encrypted_reasoning_tokens(signature.as_deref()));
                }
            },
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
/// Prepend the `<repo_map>` block to the FIRST user message of the request.
///
/// Two decisions worth keeping:
///
/// 1. **Data, not instruction.** It is not part of the system prompt. The system
///    prompt is behaviour and is identical for every project; this is facts
///    about one workspace, so it belongs in the conversation — the same split
///    `<ide_context>` and `<steering_context>` already observe.
/// 2. **First message, not latest.** Anchoring it to the head means it sits
///    inside the provider's cached prefix and is billed once. Attaching it to
///    the newest message instead would re-send several thousand tokens on every
///    single turn, which would cost more than the file reads it exists to avoid.
///
/// Same contract as [`inject_ide_context`]: the persisted session stays
/// verbatim, only the request body carries this.
impl ConversationRuntime {
    /// The `<repo_map>` block for this conversation, or `None` when there is
    /// nothing worth sending.
    ///
    /// Every failure path returns `None` on purpose. An index that cannot be
    /// built (no workspace, unreadable tree, a language nobody here parses) is
    /// a missing convenience, not a broken turn — the agent still has `code`,
    /// `grep` and `workspace_tree`.
    fn repo_map_block(&self, workspace_root: Option<&str>) -> Option<String> {
        self.repo_map
            .get_or_init(|| {
                let root = std::path::PathBuf::from(workspace_root?);
                let idx = crate::code_index::service().get_or_build(&root).ok()?;
                crate::code_index::repo_map::render(
                    &idx,
                    crate::code_index::repo_map::budget_chars(
                        crate::code_index::repo_map::DEFAULT_BUDGET_TOKENS,
                    ),
                )
            })
            .clone()
    }
}

fn inject_repo_map(messages: &[ConversationMessage], repo_map: &str) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().position(|m| m.role == MessageRole::User) else {
        return owned;
    };
    match owned[idx].blocks.first_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{repo_map}\n\n{text}");
        }
        _ => {
            owned[idx].blocks.insert(
                0,
                ContentBlock::Text {
                    text: repo_map.to_string(),
                },
            );
        }
    }
    owned
}

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

/// Render the live checklist as an `<aurora_task_reminder>` block, or `None`
/// when this conversation is not tracking any tasks.
///
/// Read from the STORE on every request rather than remembered, so the block
/// is the same truth the user's checklist panel is drawing. The model
/// therefore never has to call `op: "read"` to find out where it stands, and a
/// list that scrolled out of its context — or was written before a compaction
/// — is still in front of it.
fn task_reminder_block(thread_id: &str) -> Option<String> {
    // A failure here is a missing convenience, never a broken turn: the `todo`
    // tool's own results still carry the list.
    let list = crate::tools::shell_editor_todo::todo_store::read(thread_id).ok()?;
    if list.items.is_empty() {
        return None;
    }

    use crate::tools::shell_editor_todo::todo_store::TodoStatus;

    let cursor = list.cursor();
    let mut out = String::from("<aurora_task_reminder>\n");
    out.push_str(
        "This is your checklist for this conversation, as it stands right now. The user is \
watching it live, so keep it current with the `todo` tool — close a task the moment it is done, \
and close one and start the next in a SINGLE call.\n",
    );
    for item in &list.items {
        let mark = match item.status {
            TodoStatus::Completed => "x",
            TodoStatus::InProgress => ">",
            TodoStatus::Cancelled => "-",
            TodoStatus::Pending => " ",
        };
        out.push_str(&format!(
            "- [{mark}] {} {} ({})\n",
            item.id,
            item.content,
            item.status.as_str()
        ));
    }
    out.push_str(&format!(
        "{} closed of {}. ",
        cursor.completed + cursor.cancelled,
        cursor.total
    ));
    out.push_str(&match (&cursor.active_id, &cursor.next_id) {
        _ if cursor.complete => "Every task is closed.".to_string(),
        (Some(active), _) => format!("Now working on {active}."),
        (None, Some(next)) => {
            format!("Nothing is in progress — mark {next} in_progress when you start it.")
        }
        (None, None) => "Nothing left to start.".to_string(),
    });
    out.push_str("\n</aurora_task_reminder>");
    Some(out)
}

/// Attach the checklist to the LATEST user message.
///
/// Deliberately the opposite placement from [`inject_repo_map`], for the
/// opposite reason. The repo map is static, so it rides at the head where the
/// provider caches it once. This list changes every few tool calls; putting it
/// at the head would rewrite the cached prefix on each turn and re-bill the
/// whole conversation. Appended at the end, it costs its own ~15 tokens per
/// task and invalidates nothing.
///
/// Same contract as [`inject_ide_context`]: the persisted session stays
/// verbatim, only the request body carries this.
fn inject_task_reminder(
    messages: &[ConversationMessage],
    reminder: &str,
) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().rposition(|m| m.role == MessageRole::User) else {
        return owned;
    };
    match owned[idx].blocks.last_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{text}\n\n{reminder}");
        }
        _ => {
            owned[idx].blocks.push(ContentBlock::Text {
                text: reminder.to_string(),
            });
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
        // Sticky across the turn: if ANY request in it was an estimate, the
        // turn's totals are approximate and must not read as measured.
        estimated: match (a.estimated, b.estimated) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            _ => None,
        },
        // Money adds. `None + None` stays `None` so "the provider never priced
        // this" is distinguishable from "the provider priced it at zero" — the
        // first must fall back to catalog rates, the second must not.
        cost_usd: match (a.cost_usd, b.cost_usd) {
            (Some(x), Some(y)) => Some(x + y),
            (Some(x), None) | (None, Some(x)) => Some(x),
            (None, None) => None,
        },
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

    /// An edit result's before/after echo is content the model itself sent —
    /// it must never reach model history, whatever its size. Counts and the
    /// message stay; the elision names itself and the recovery.
    #[test]
    fn edit_results_drop_their_content_echo_from_model_history() {
        let raw = serde_json::json!({
            "success": true,
            "message": "Edited 1 file (2 replacements)",
            "path": "src/app.ts",
            "linesAdded": 4,
            "linesRemoved": 1,
            "oldContent": "x".repeat(500),
            "newContent": "y".repeat(500),
        })
        .to_string();

        let out = truncate_tool_content("file_edit", raw);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(parsed.get("oldContent").is_none(), "echo dropped");
        assert!(parsed.get("newContent").is_none(), "echo dropped");
        assert_eq!(parsed["linesAdded"], 4, "signal kept");
        assert!(
            parsed["contentEcho"]
                .as_str()
                .unwrap()
                .contains("file_read"),
            "elision names its recovery"
        );
    }

    /// The multi-file batch shape carries the echo per entry in `files[]`.
    #[test]
    fn multi_file_edit_results_drop_per_file_echo() {
        let raw = serde_json::json!({
            "success": true,
            "multiFile": true,
            "files": [
                { "path": "a.ts", "success": true, "oldContent": "a", "newContent": "b" },
                { "path": "b.ts", "success": true, "oldContent": "c", "newContent": "d" },
            ],
        })
        .to_string();

        let out = truncate_tool_content("file_edit", raw);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        for file in parsed["files"].as_array().unwrap() {
            assert!(file.get("oldContent").is_none());
            assert!(file.get("newContent").is_none());
            assert!(file.get("path").is_some(), "identity kept");
        }
    }

    /// A failure result has no echo to strip and must pass through untouched —
    /// its corrective message is exactly what the model needs verbatim.
    #[test]
    fn edit_failures_are_left_alone() {
        let raw = serde_json::json!({
            "success": false,
            "error": "could not find the specified text",
            "hint": "Call file_read on this path, then retry.",
        })
        .to_string();
        assert_eq!(truncate_tool_content("file_edit", raw.clone()), raw);
    }

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

    /// Prose that documents the marker syntax — `.knowledge/knowledge.md` and
    /// this project's own source both do — must not be mistaken for a
    /// screenshot. Before the validated parse it took the leanify branch, so it
    /// skipped the size cap AND was handed to the provider adapter as an image.
    #[test]
    fn text_quoting_the_marker_syntax_is_not_a_screenshot() {
        let prose = format!(
            "FIX: `truncate_tool_content` returns early when `s.contains(\"<aurora_image \")`.\n\
             {}\n\
             The MODEL copy keeps the full `<aurora_image>` block (vision), the UI copy is lean.\n",
            "context line\n".repeat(4_000),
        );

        // A tool whose results are clamped: the cap must still apply.
        let out = truncate_tool_content("grep", prose.clone());
        assert!(out.len() < prose.len(), "size cap must still apply");
        assert!(out.contains("[truncated"), "clamp marker present");

        // And the adapter must see text, not an image.
        assert!(!crate::api::aurora_image::has_marker(&prose));
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

        let compacted = truncate_tool_content("file_edit", raw);
        assert!(compacted.len() <= MAX_TOOL_RESULT_LENGTH);
        let parsed: serde_json::Value =
            serde_json::from_str(&compacted).expect("history result must stay valid JSON");
        assert_eq!(parsed["path"], "src/App.tsx");
        // The echo is stripped outright (see `strip_edit_content_echo`), so a
        // large edit result never even reaches the shrink-to-fit pass.
        assert!(parsed.get("oldContent").is_none());
        assert!(parsed.get("newContent").is_none());
        assert_eq!(parsed["linesAdded"], 2);
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
        assert_eq!(
            compacted, raw,
            "a default-budget tree must pass through whole"
        );
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

    /// Streams an assistant message and then cancels the turn — the user
    /// pressing Stop while the tool calls are still arriving, which is the
    /// window that used to leave `tool_use` blocks unanswered forever.
    struct CancelWhileStreamingApi {
        message: Mutex<Option<ConversationMessage>>,
    }

    #[async_trait]
    impl StreamingApiClient for CancelWhileStreamingApi {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let message = self
                .message
                .lock()
                .expect("message mutex")
                .take()
                .expect("CancelWhileStreamingApi called twice — test bug");
            cancel_token.cancel();
            Ok(turn_usage(message, "tool_use"))
        }
    }

    /// Tool that reports the turn was cancelled while it was running.
    struct CancellingTool {
        name: &'static str,
    }

    #[async_trait]
    impl super::super::tool_executor::ToolExecutor for CancellingTool {
        fn name(&self) -> &str {
            self.name
        }
        fn schema(&self) -> super::super::api_client::ToolSchema {
            super::super::api_client::ToolSchema {
                name: self.name.into(),
                description: "test canceller".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }
        }
        async fn execute(
            &self,
            _input: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<String, ToolError> {
            Err(ToolError::Cancelled)
        }
    }

    fn assistant_tool_uses(calls: &[(&str, &str)]) -> ConversationMessage {
        ConversationMessage::assistant(
            calls
                .iter()
                .map(|(id, name)| ContentBlock::ToolUse {
                    id: (*id).into(),
                    name: (*name).into(),
                    input: serde_json::json!({}),
                })
                .collect(),
            1_700_000_000_000,
        )
    }

    /// Ids of every `tool_use` in the session that no `tool_result` answers.
    /// Non-empty means the next request to any provider is a 400.
    fn unanswered_tool_use_ids(session: &Session) -> Vec<String> {
        let mut requested: Vec<String> = Vec::new();
        let mut answered: Vec<String> = Vec::new();
        for message in session.messages() {
            for block in &message.blocks {
                match block {
                    ContentBlock::ToolUse { id, .. } => requested.push(id.clone()),
                    ContentBlock::ToolResult { tool_use_id, .. } => {
                        answered.push(tool_use_id.clone())
                    }
                    _ => {}
                }
            }
        }
        requested
            .into_iter()
            .filter(|id| !answered.contains(id))
            .collect()
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
                estimated: None,
                cost_usd: None,
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

    /// The reported bug, end to end: Stop pressed after the tool calls streamed
    /// in but before any of them ran, then a new prompt. The assistant message
    /// is already persisted; if its `tool_use` blocks go unanswered the thread
    /// is malformed on disk and EVERY later turn dies with a provider 400.
    #[tokio::test]
    async fn stopping_before_the_tools_run_leaves_no_unanswered_call() {
        let api = Arc::new(CancelWhileStreamingApi {
            message: Mutex::new(Some(assistant_tool_uses(&[
                ("call-1", "echo"),
                ("call-2", "echo"),
            ]))),
        });

        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "hi".into(),
        }));

        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(64);

        let outcome = runtime
            .run_turn(
                &mut session,
                user_msg("read both"),
                tx,
                CancellationToken::new(),
            )
            .await;

        assert!(matches!(outcome, Err(RuntimeError::Cancelled)));
        assert!(
            seen.lock().expect("seen").is_empty(),
            "cancelling before dispatch must not run the tools"
        );
        assert!(
            unanswered_tool_use_ids(&session).is_empty(),
            "every tool_use must carry an answer or the thread is malformed: {:?}",
            unanswered_tool_use_ids(&session),
        );

        // And the answers say why, so the model doesn't read them as real output.
        let answers: Vec<&str> = session
            .messages()
            .iter()
            .flat_map(|m| &m.blocks)
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    content, is_error, ..
                } => Some((content.as_str(), *is_error)),
                _ => None,
            })
            .map(|(content, is_error)| {
                assert_eq!(is_error, Some(true), "a stopped call is not a success");
                content
            })
            .collect();
        assert_eq!(answers, [STOPPED_BEFORE_RUN, STOPPED_BEFORE_RUN]);
    }

    /// Stop pressed while a tool is mid-flight. Results that already landed are
    /// kept, the interrupted call is marked, and calls that never got dispatched
    /// are answered too — all three kinds must appear or the pairing breaks.
    #[tokio::test]
    async fn stopping_during_a_tool_keeps_finished_work_and_answers_the_rest() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_uses(&[
                    ("call-1", "echo"),
                    ("call-2", "stopper"),
                    ("call-3", "echo"),
                ]),
                "tool_use",
            )),
        }]));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "hi".into(),
        }));
        tools.register(Arc::new(CancellingTool { name: "stopper" }));

        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(64);

        let outcome = runtime
            .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
            .await;

        assert!(matches!(outcome, Err(RuntimeError::Cancelled)));
        assert!(
            unanswered_tool_use_ids(&session).is_empty(),
            "unanswered after a mid-tool stop: {:?}",
            unanswered_tool_use_ids(&session),
        );

        let answers: Vec<(String, String)> = session
            .messages()
            .iter()
            .flat_map(|m| &m.blocks)
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => Some((tool_use_id.clone(), content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(answers.len(), 3, "one answer per call, in call order");
        assert_eq!(answers[0], ("call-1".to_string(), "hi".to_string()));
        assert_eq!(answers[1].1, STOPPED_MID_RUN);
        assert_eq!(answers[2].1, STOPPED_BEFORE_RUN);
        assert_eq!(
            seen.lock().expect("seen").len(),
            1,
            "the call after the cancelled one must never dispatch"
        );
    }

    /// A reply cut off by the output cap WHILE emitting tool calls. The
    /// arguments that parsed may be silently incomplete and the calls after the
    /// cut are missing entirely, so none of them are safe to run — and the user
    /// has to be told, which on this path used to happen nowhere.
    #[tokio::test]
    async fn a_reply_cut_off_mid_tool_call_fails_the_batch_and_says_so() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_uses(&[("call-1", "echo")]),
                "length",
            )),
        }]));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let tools = Arc::new(ToolRegistry::new());
        tools.register(Arc::new(RecordingTool {
            name: "echo",
            seen: seen.clone(),
            response: "hi".into(),
        }));

        let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(64);

        let summary = runtime
            .run_turn(
                &mut session,
                user_msg("write it"),
                tx,
                CancellationToken::new(),
            )
            .await
            .expect("a truncated batch ends the turn, it does not fail it");

        assert_eq!(summary.stop_reason, "length");
        assert_eq!(
            summary.iterations, 1,
            "the turn stops; retrying re-truncates"
        );
        assert!(
            seen.lock().expect("seen").is_empty(),
            "a call whose arguments may be truncated must not execute"
        );
        assert!(unanswered_tool_use_ids(&session).is_empty());

        let answered_with: Vec<&str> = session
            .messages()
            .iter()
            .flat_map(|m| &m.blocks)
            .filter_map(|b| match b {
                ContentBlock::ToolResult { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(answered_with, [TRUNCATED_CALL]);

        // The user is told, and the notice survives a reload.
        assert!(
            session.messages().iter().flat_map(|m| &m.blocks).any(
                |b| matches!(b, ContentBlock::Notice { message, .. } if message.contains("cut off"))
            ),
            "the truncation notice must be persisted on this path too",
        );
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

        let batch = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runtime.execute_tool_calls(calls, &session, "turn-1", &cancel, &tx, &mut seq),
        )
        .await
        .expect("three concurrency-safe calls must overlap, not serialize")
        .expect("ok");

        waiter.await.expect("waiter");
        assert!(!batch.cancelled);
        assert_eq!(batch.message.blocks.len(), 3);
        // Order follows the model's call order, not completion order.
        for (i, block) in batch.message.blocks.iter().enumerate() {
            match block {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    assert_eq!(*tool_use_id, format!("call-{i}"));
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
        let batch = runtime
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

        assert_eq!(batch.message.blocks.len(), 3);
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
                        estimated: None,
                        cost_usd: None,
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
                        estimated: None,
                        cost_usd: None,
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
                        estimated: None,
                        cost_usd: None,
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
                        estimated: None,
                        cost_usd: None,
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

        // Each persisted call carries ITS OWN usage, not the turn total — the
        // thread's cost is re-derived from these on reload, so they have to be
        // per-request and complete.
        let persisted: Vec<&TokenUsage> = session
            .messages
            .iter()
            .filter(|m| m.role == MessageRole::Assistant)
            .filter_map(|m| m.usage.as_ref())
            .collect();
        assert_eq!(persisted.len(), 2, "every API call persists its usage");
        assert_eq!(persisted[0].input_tokens, 10);
        assert_eq!(persisted[1].input_tokens, 5);
    }

    /// Cost is per-model and the model can change between turns, so a total
    /// summed from the transcript can only be right if each call says which
    /// model produced it.
    #[tokio::test]
    async fn persisted_assistant_messages_record_the_model_that_ran_them() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    estimated: None,
                    cost_usd: None,
                },
                stop_reason: "end_turn".into(),
                assistant_message: assistant_text("done"),
            }),
        }]));
        let runtime =
            ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

        let mut session = Session::new("t");
        session.model = Some("openai:gpt-5.6".into());
        let (tx, _rx) = mpsc::channel(32);

        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let assistant = session
            .messages
            .iter()
            .find(|m| m.role == MessageRole::Assistant)
            .expect("assistant message");
        assert_eq!(assistant.model.as_deref(), Some("openai:gpt-5.6"));
    }

    /// A provider that reports no usage used to persist ZEROS while the live UI
    /// showed an estimate, so reopening the chat totalled an exact-looking
    /// $0.00. The estimate must be persisted AND flagged, so the cost renders
    /// as approximate rather than as free.
    #[tokio::test]
    async fn a_no_usage_provider_persists_a_flagged_estimate_not_zeros() {
        let api = Arc::new(MockApi::new(vec![TurnScript {
            events: vec![],
            result: Ok(TurnUsage {
                usage: TokenUsage::default(), // provider reported nothing
                stop_reason: "end_turn".into(),
                assistant_message: assistant_text("a reply with real content in it"),
            }),
        }]));
        let runtime =
            ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

        let mut session = Session::new("t");
        let (tx, _rx) = mpsc::channel(32);

        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("ok");

        let usage = session
            .messages
            .iter()
            .find(|m| m.role == MessageRole::Assistant)
            .and_then(|m| m.usage.clone())
            .expect("usage persisted");
        assert_eq!(usage.estimated, Some(true), "flagged as an estimate");
        assert!(
            usage.output_tokens > 0,
            "the estimate is persisted, not zeros"
        );
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

    #[test]
    fn the_task_reminder_rides_on_the_latest_user_message() {
        // The opposite placement from the repo map, for the opposite reason:
        // this list changes every few tool calls, so at the head it would
        // rewrite the cached prefix and re-bill the whole conversation.
        let msgs = vec![
            ConversationMessage::user_text("first question", 0),
            ConversationMessage::user_text("second question", 1),
        ];
        let out = inject_task_reminder(
            &msgs,
            "<aurora_task_reminder>\n- [ ] t1 Do it (pending)\n</aurora_task_reminder>",
        );

        let head = match &out[0].blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        assert!(
            !head.contains("aurora_task_reminder"),
            "older messages stay untouched, or the cached prefix moves: {head}"
        );

        let last = match &out[1].blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        assert!(last.starts_with("second question"), "{last}");
        assert!(last.contains("<aurora_task_reminder>"), "{last}");
    }

    #[test]
    fn the_task_reminder_states_every_status_and_where_the_agent_is() {
        use crate::tools::shell_editor_todo::todo_store::{self, TodoItem, TodoList, TodoStatus};

        let thread = format!("reminder-test-{}", std::process::id());
        assert!(
            task_reminder_block(&thread).is_none(),
            "no list means no block — an empty reminder is pure cost"
        );

        let mut list = TodoList::default();
        for (id, content, status) in [
            ("t1", "Read the code", TodoStatus::Completed),
            ("t2", "Fix the bug", TodoStatus::InProgress),
            ("t3", "Run the tests", TodoStatus::Pending),
            ("t4", "Update the docs", TodoStatus::Cancelled),
        ] {
            list.items.push(TodoItem {
                id: id.into(),
                content: content.into(),
                active_form: content.into(),
                status,
            });
        }
        todo_store::write(&thread, &list).expect("write");

        let block = task_reminder_block(&thread).expect("a tracked list produces a block");
        assert!(block.starts_with("<aurora_task_reminder>"));
        assert!(block.ends_with("</aurora_task_reminder>"));
        // Every task, with its status readable both as a mark and as a word.
        assert!(
            block.contains("- [x] t1 Read the code (completed)"),
            "{block}"
        );
        assert!(
            block.contains("- [>] t2 Fix the bug (in_progress)"),
            "{block}"
        );
        assert!(
            block.contains("- [ ] t3 Run the tests (pending)"),
            "{block}"
        );
        assert!(
            block.contains("- [-] t4 Update the docs (cancelled)"),
            "{block}"
        );
        // Cancelled counts as closed, exactly like the user's checklist counts.
        assert!(block.contains("2 closed of 4"), "{block}");
        assert!(block.contains("Now working on t2."), "{block}");

        todo_store::clear(&thread).ok();
    }

    #[test]
    fn repo_map_rides_on_the_first_user_message_not_the_latest() {
        // Placement is the whole cost model. At the head it sits inside the
        // provider's cached prefix and is billed once; on the newest message it
        // would be re-sent in full every turn, costing more than the file reads
        // it exists to avoid.
        let msgs = vec![
            ConversationMessage::user_text("first question", 0),
            ConversationMessage::user_text("second question", 1),
        ];
        let out = inject_repo_map(
            &msgs,
            "<repo_map>
src/
</repo_map>",
        );

        let head = match &out[0].blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        assert!(head.starts_with("<repo_map>"), "{head}");
        assert!(
            head.contains("first question"),
            "original text must survive"
        );

        let last = match &out[1].blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        assert!(
            !last.contains("<repo_map>"),
            "the latest message must stay untouched: {last}"
        );
    }

    #[test]
    fn repo_map_injection_leaves_the_persisted_messages_verbatim() {
        // Same contract as inject_ide_context: the JSONL on disk holds the
        // user's words, and only the request body carries Aurora's additions.
        let msgs = vec![ConversationMessage::user_text("original", 0)];
        let out = inject_repo_map(&msgs, "<repo_map>x</repo_map>");

        match &msgs[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "original"),
            other => panic!("expected text, got {other:?}"),
        }
        match &out[0].blocks[0] {
            ContentBlock::Text { text } => assert!(text.contains("<repo_map>")),
            other => panic!("expected text, got {other:?}"),
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

    #[tokio::test(start_paused = true)]
    async fn run_turn_propagates_recoverable_api_error_with_event() {
        // A rate limit is retried before it is reported, so the script has to
        // fail every attempt for the error to reach the user at all. That IS
        // the contract: the Error event is what the user sees once retrying
        // has been tried and failed, not the first thing that goes wrong.
        let script = (0..MAX_STREAM_ATTEMPTS)
            .map(|_| TurnScript {
                events: vec![],
                result: Err(ApiError::RateLimit),
            })
            .collect();
        let api = Arc::new(MockApi::new(script));
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

        // Drain to the Error event: the retries announce themselves first.
        let mut error_event = None;
        let mut discards = 0_u32;
        while let Ok(Some(envelope)) =
            tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
        {
            match envelope.event {
                AssistantEvent::PartialReplyDiscarded { .. } => discards += 1,
                AssistantEvent::Error {
                    message,
                    recoverable,
                } => {
                    error_event = Some((message, recoverable));
                    break;
                }
                other => panic!("unexpected event before the error: {other:?}"),
            }
        }

        assert_eq!(
            discards,
            MAX_STREAM_ATTEMPTS - 1,
            "one discard per retry, and no discard for the attempt that gave up",
        );
        let (message, recoverable) = error_event.expect("the error must still reach the user");
        assert!(recoverable, "rate-limit must be recoverable");
        assert!(message.contains("rate"), "got message: {message}");
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
        let outcome = trim_to_budget(messages.clone(), None, 4096, "", ReasoningReplay::Text);
        assert_eq!(outcome.dropped, 0);
        assert_eq!(outcome.messages, messages);
    }

    #[test]
    fn trim_is_noop_when_under_threshold() {
        // 200k window minus 4096 reserved → ~195k budget; threshold is
        // ~146k. Two short messages don't come close.
        let messages = vec![user_with_text("hi", 0), assistant_with_text("ok", 1)];
        let outcome = trim_to_budget(
            messages.clone(),
            Some(200_000),
            4096,
            "system",
            ReasoningReplay::Text,
        );
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

        let outcome = trim_to_budget(messages, Some(1000), 100, "", ReasoningReplay::Text);

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

        let outcome = trim_to_budget(messages.clone(), Some(1000), 100, "", ReasoningReplay::Text);

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
            model: None,
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

        let outcome = trim_to_budget(messages, Some(1000), 100, "", ReasoningReplay::Text);

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
        let outcome = trim_to_budget(
            messages.clone(),
            Some(1000),
            5000,
            "",
            ReasoningReplay::Text,
        );
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
        assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Text), 4);
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
        assert!(estimate_message_tokens(&m, ReasoningReplay::Text) >= 12);
    }

    /// One assistant message carrying a Responses-API reasoning item: a short
    /// summary plus the fat encrypted blob Aurora stores in `signature`.
    fn assistant_with_reasoning(text: &str, signature: &str) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![ContentBlock::Thinking {
                text: text.into(),
                signature: Some(signature.into()),
                duration_ms: None,
            }],
            0,
        )
    }

    /// The bug this whole policy exists for.
    ///
    /// A chat that ran a Responses-API model banks megabytes of encrypted
    /// reasoning in its transcript. Switch to a provider that strips reasoning
    /// and NONE of it is ever sent again — but the estimator used to run
    /// tiktoken over the base64 anyway. On a real 180k-token session that
    /// invented ~92k tokens of context, so `/compact` reported a "before" of
    /// 431k and an "after" of 272k for a request the provider measured at 180k.
    #[test]
    fn dropped_reasoning_costs_nothing() {
        let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
        let m = assistant_with_reasoning("brief summary", &blob);

        // Per-message overhead only: neither the summary nor the blob is sent.
        assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Dropped), 4);
    }

    #[test]
    fn text_replay_counts_the_summary_but_never_the_signature() {
        let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
        let with_blob = assistant_with_reasoning("brief summary", &blob);
        let without_blob = assistant_with_reasoning("brief summary", "");

        // The signature is transport metadata — an id or an HMAC the provider
        // verifies. It is never prompt text, so it must not move the number.
        assert_eq!(
            estimate_message_tokens(&with_blob, ReasoningReplay::Text),
            estimate_message_tokens(&without_blob, ReasoningReplay::Text),
        );
        assert!(estimate_message_tokens(&with_blob, ReasoningReplay::Text) > 4);
    }

    #[test]
    fn opaque_replay_prices_the_plaintext_not_the_ciphertext() {
        let blob = "gAAAAABqdpHR1SNl885r9cogd1rJiInPBBO4WmifWtviQ2nLyXqJ".repeat(40);
        let m = assistant_with_reasoning("brief summary", &blob);

        let opaque = estimate_message_tokens(&m, ReasoningReplay::Opaque);
        // It DOES cost something — the item is genuinely replayed.
        assert!(opaque > 4);
        // …but far less than tokenizing the base64, which is what made the
        // old estimate ~2.6x high even on the provider that replays it.
        let as_raw_text = estimate_text_tokens(&blob);
        assert!(
            opaque < as_raw_text / 2,
            "opaque={opaque} should be well under raw-text {as_raw_text}",
        );
    }

    #[test]
    fn opaque_replay_of_a_missing_signature_costs_nothing() {
        let m = ConversationMessage::assistant(
            vec![ContentBlock::Thinking {
                text: "summary".into(),
                signature: None,
                duration_ms: None,
            }],
            0,
        );
        // No item to replay → nothing on the wire.
        assert_eq!(estimate_message_tokens(&m, ReasoningReplay::Opaque), 4);
    }

    /// Records the full request shape, so a test can assert on the things the
    /// provider's cache key is actually made of.
    #[derive(Default)]
    struct CacheKeyRecordingApi {
        reply: String,
        seen: Mutex<Vec<(Option<String>, usize, bool, usize)>>,
    }

    #[async_trait]
    impl StreamingApiClient for CacheKeyRecordingApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            self.seen.lock().expect("seen").push((
                request.system_prompt.map(str::to_string),
                request.tools.len(),
                request.thinking_enabled,
                request.messages.len(),
            ));
            Ok(turn_usage(assistant_text(&self.reply), "end_turn"))
        }
    }

    fn cache_key_api(reply: &str) -> Arc<CacheKeyRecordingApi> {
        Arc::new(CacheKeyRecordingApi {
            reply: reply.to_string(),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn one_tool_registry() -> Arc<ToolRegistry> {
        let registry = ToolRegistry::new();
        registry.register(Arc::new(RecordingTool {
            name: "file_read",
            seen: Arc::new(Mutex::new(Vec::new())),
            response: "ok".into(),
        }));
        Arc::new(registry)
    }

    #[tokio::test]
    async fn summarizing_on_the_chat_model_reuses_its_prompt_prefix() {
        // The head is ALREADY in the provider's cache from the turns that
        // built it — but only if this request keeps the same prefix. System
        // prompt, tools and thinking config are all part of the cache key;
        // changing any of them re-bills the entire history at fresh rates.
        let chat = cache_key_api("<summary>note</summary>");
        let runtime = ConversationRuntime::new(
            chat.clone(),
            one_tool_registry(),
            RuntimeConfig {
                system_prompt: Some("you are aurora".into()),
                context_window: Some(4000),
                thinking_enabled: true,
                ..RuntimeConfig::default()
            },
        );

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;
        assert!(runtime
            .compact_now(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new()
            )
            .await
            .is_some());

        let seen = chat.seen.lock().expect("seen");
        let (system, tools, thinking, _) = seen.first().expect("summarizer ran");
        assert_eq!(
            system.as_deref(),
            Some("you are aurora"),
            "a different system prompt diverges the prefix at token zero",
        );
        assert_eq!(*tools, 1, "dropping the tools invalidates the cache key");
        assert!(*thinking, "thinking config is part of the cache key");
    }

    #[tokio::test]
    async fn a_pinned_model_sends_the_lean_request_instead() {
        // A pinned model has no cache to share, so there is nothing to protect
        // and every token saved is real: dedicated prompt, no tools, no
        // reasoning, thinking off.
        let summarizer = cache_key_api("<summary>note</summary>");
        let runtime = ConversationRuntime::new(
            recording_api("chat"),
            one_tool_registry(),
            RuntimeConfig {
                system_prompt: Some("you are aurora".into()),
                context_window: Some(4000),
                thinking_enabled: true,
                ..RuntimeConfig::default()
            },
        )
        .with_compaction_client(summarizer.clone(), "cheap:model");

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;
        assert!(runtime
            .compact_now(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new()
            )
            .await
            .is_some());

        let seen = summarizer.seen.lock().expect("seen");
        let (system, tools, thinking, _) = seen.first().expect("summarizer ran");
        assert_ne!(system.as_deref(), Some("you are aurora"));
        assert_eq!(*tools, 0);
        assert!(!*thinking);
    }

    #[tokio::test]
    async fn a_tool_call_instead_of_a_note_falls_back_rather_than_failing() {
        // Advertising tools is the price of the cache, and the model will
        // occasionally reach for one instead of answering. That must not burn
        // a compaction attempt — it re-bills, it does not fail.
        let chat = cache_key_api(""); // empty text, as a tool call would leave
        let runtime = ConversationRuntime::new(
            chat.clone(),
            one_tool_registry(),
            RuntimeConfig {
                system_prompt: Some("you are aurora".into()),
                context_window: Some(4000),
                ..RuntimeConfig::default()
            },
        );

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;
        let _ = runtime
            .compact_now(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;

        let seen = chat.seen.lock().expect("seen");
        assert_eq!(seen.len(), 2, "should retry once in the standalone shape");
        assert_eq!(
            seen[0].1, 1,
            "first attempt keeps the tools (for the cache)"
        );
        assert_eq!(
            seen[1].1, 0,
            "retry drops them so the note cannot be misread"
        );
    }

    #[tokio::test]
    async fn the_summarizer_never_sees_the_chat_model_s_reasoning() {
        // A signature is issued by one provider and meaningless to another,
        // and this request runs with thinking OFF — yet the Anthropic
        // converter emits `thinking` blocks regardless. Left in, summarizing
        // on a different provider fails on every attempt.
        let summarizer = recording_api("a summary");
        let runtime = ConversationRuntime::new(
            recording_api("chat"),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                context_window: Some(4000),
                ..RuntimeConfig::default()
            },
        )
        .with_compaction_client(summarizer.clone(), "other-provider:other-model");

        let mut session = compactable_session();
        // Reasoning carried over from the chat model, signature and all.
        session.append_message(assistant_with_reasoning(
            "mulling it over",
            "sig-from-openai",
        ));
        session.append_message(user_with_text("carry on", 99));

        let head = strip_reasoning(session.messages().to_vec());
        assert!(
            !head
                .iter()
                .flat_map(|m| &m.blocks)
                .any(|b| matches!(b, ContentBlock::Thinking { .. })),
            "no reasoning block may reach the summarizer",
        );
        // The reasoning-only message is gone entirely — an empty content array
        // is rejected by providers.
        assert!(head.len() < session.messages().len());

        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;
        let result = runtime
            .compact_now(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;
        assert!(
            result.is_some(),
            "cross-provider compaction must still succeed"
        );
    }

    #[test]
    fn stripping_reasoning_leaves_tool_pairing_intact() {
        // Nothing carrying a tool call can be emptied by the strip, so the
        // call/result pairing the provider validates is untouched.
        let messages = vec![
            ConversationMessage::assistant(
                vec![
                    ContentBlock::Thinking {
                        text: "hmm".into(),
                        signature: Some("sig".into()),
                        duration_ms: None,
                    },
                    ContentBlock::ToolUse {
                        id: "call-1".into(),
                        name: "file_read".into(),
                        input: serde_json::json!({"path": "a.rs"}),
                    },
                ],
                0,
            ),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![ContentBlock::ToolResult {
                    tool_use_id: "call-1".into(),
                    content: "fn main() {}".into(),
                    is_error: Some(false),
                }],
                usage: None,
                timestamp: 1,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                model: None,
            },
        ];

        let stripped = strip_reasoning(messages);
        assert_eq!(stripped.len(), 2, "neither message may be dropped");
        assert!(matches!(
            stripped[0].blocks.as_slice(),
            [ContentBlock::ToolUse { .. }]
        ));
    }

    #[test]
    fn the_drafting_scratchpad_never_reaches_context() {
        let raw = "<analysis>\nChronological pass, 4000 tokens of it.\n</analysis>\n\n\
                   <summary>\n1. Primary request: ship the parser.\n</summary>";
        let out = format_compact_summary(raw);
        assert_eq!(out, "1. Primary request: ship the parser.");
        assert!(!out.contains("Chronological"), "analysis must be dropped");
    }

    #[test]
    fn a_summary_cut_off_mid_note_keeps_what_was_written() {
        // The output budget ran out. The early sections are the valuable ones
        // — discarding them would fail the compaction over a missing tag.
        let raw = "<analysis>draft</analysis>\n<summary>\n1. Primary request: ship it.\n2. Files";
        let out = format_compact_summary(raw);
        assert!(out.starts_with("1. Primary request: ship it."));
        assert!(!out.contains("draft"));
    }

    #[test]
    fn an_unclosed_analysis_block_does_not_swallow_the_note() {
        // The model wrote the whole note but forgot `</analysis>`. Cutting at
        // the missing tag would discard a perfectly good summary and fail the
        // compaction over punctuation.
        let raw = "<analysis>\nthinking out loud\n<summary>\n1. Ship the parser.\n</summary>";
        let out = format_compact_summary(raw);
        assert_eq!(out, "1. Ship the parser.");
        assert!(!out.contains("thinking out loud"));
    }

    #[test]
    fn a_summary_that_ignored_the_tags_is_still_used() {
        // Tags are a request, not a guarantee. A plain-prose summary is worth
        // far more than treating the compaction as failed.
        let out = format_compact_summary("  We were refactoring the parser.  ");
        assert_eq!(out, "We were refactoring the parser.");
    }

    #[test]
    fn the_resume_note_tells_the_model_to_continue_seamlessly() {
        let view = compaction_preamble("1. Primary request: ship it.", None);
        assert!(view.contains("1. Primary request: ship it."));
        // The whole point of the user-facing behaviour: no seam.
        assert!(view.contains("do not mention the summary"));
        assert!(view.contains("preserved word for word"));
        // No path was offered, so none must be promised.
        assert!(!view.contains("file_read"));
    }

    #[test]
    fn the_resume_note_offers_the_transcript_when_it_is_readable() {
        let view = compaction_preamble("note", Some("C:/sessions/t-1.jsonl"));
        assert!(view.contains("C:/sessions/t-1.jsonl"));
        assert!(view.contains("file_read"));
    }

    #[tokio::test]
    async fn the_transcript_is_only_offered_when_the_model_could_open_it() {
        let session = Session::new("t-hint");
        let with_tools = |allow: bool| {
            ConversationRuntime::new(
                recording_api("ok"),
                Arc::new(ToolRegistry::new()),
                RuntimeConfig {
                    allow_outside_workspace: allow,
                    ..RuntimeConfig::default()
                },
            )
            .with_store_dir("C:/sessions")
        };
        // The session store is outside the workspace: without the opt-in the
        // read is refused, and naming a path the model cannot open is worse
        // than saying nothing.
        assert!(with_tools(false).transcript_hint(&session).is_none());
        assert!(with_tools(true).transcript_hint(&session).is_some());
    }

    fn measured(input: u32, cache_write: u32, cache_read: u32, output: u32) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: Some(cache_write),
            cache_read_input_tokens: Some(cache_read),
            estimated: None,
            cost_usd: None,
        }
    }

    /// Returns a blockless assistant message on the first call and a normal
    /// one afterwards — the shape a dropped `redacted_thinking` block left
    /// behind, reproduced from two real sessions where the provider billed
    /// output tokens and Aurora persisted nothing.
    #[derive(Default)]
    struct EmptyThenAnswerApi {
        calls: Mutex<u32>,
    }

    #[async_trait]
    impl StreamingApiClient for EmptyThenAnswerApi {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let mut calls = self.calls.lock().expect("calls");
            *calls += 1;
            if *calls == 1 {
                return Ok(turn_usage(
                    ConversationMessage::assistant(Vec::new(), 0),
                    "end_turn",
                ));
            }
            Ok(turn_usage(assistant_text("here is the answer"), "end_turn"))
        }
    }

    #[tokio::test]
    async fn a_response_with_no_blocks_is_retried_once_instead_of_surfacing() {
        let api = Arc::new(EmptyThenAnswerApi::default());
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let mut session = Session::new("t-empty");
        let (tx, _rx) = mpsc::channel(64);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("turn should succeed on the retry");

        assert_eq!(*api.calls.lock().expect("calls"), 2, "should re-issue once");

        // The blockless response must leave NO trace in history. Serialized to
        // Anthropic it becomes an assistant turn with empty content, which the
        // API rejects — one dropped response would break every later turn.
        assert!(
            session.messages().iter().all(|m| !m.blocks.is_empty()),
            "an empty assistant message must never enter history",
        );
        assert!(
            session.messages().iter().any(|m| matches!(
                m.blocks.first(),
                Some(ContentBlock::Text { text }) if text == "here is the answer"
            )),
            "the retry's answer must be kept",
        );
    }

    // ── Dropped-stream retry ────────────────────────────────────────

    /// Streams a little text, then dies the way a real dropped connection
    /// does, for the first `fail_times` calls. Mirrors the failure that
    /// dominated `aurora.log`: partial output already on screen when the
    /// socket goes away.
    struct DropsThenAnswersApi {
        calls: Mutex<u32>,
        fail_times: u32,
        error: ApiError,
    }

    impl DropsThenAnswersApi {
        fn new(fail_times: u32, error: ApiError) -> Self {
            Self {
                calls: Mutex::new(0),
                fail_times,
                error,
            }
        }

        fn call_count(&self) -> u32 {
            *self.calls.lock().expect("calls")
        }
    }

    #[async_trait]
    impl StreamingApiClient for DropsThenAnswersApi {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            let call = {
                let mut calls = self.calls.lock().expect("calls");
                *calls += 1;
                *calls
            };
            if call <= self.fail_times {
                // Some of the reply reached the screen before the drop.
                let _ = event_sink
                    .send(AssistantEvent::TextDelta {
                        delta: "The project is ".into(),
                    })
                    .await;
                return Err(self.error.clone());
            }
            Ok(turn_usage(assistant_text("here is the answer"), "end_turn"))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_stream_is_retried_without_the_user_asking() {
        let api = Arc::new(DropsThenAnswersApi::new(
            1,
            ApiError::Network("stream error: error decoding response body".into()),
        ));
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let mut session = Session::new("t-drop");
        let (tx, _rx) = mpsc::channel(64);
        runtime
            .run_turn(
                &mut session,
                user_msg("check project"),
                tx,
                CancellationToken::new(),
            )
            .await
            .expect("a dropped stream must not end the turn");

        assert_eq!(api.call_count(), 2, "should re-issue exactly once");
        assert!(
            session.messages().iter().any(|m| matches!(
                m.blocks.first(),
                Some(ContentBlock::Text { text }) if text == "here is the answer"
            )),
            "the retry's answer must be kept",
        );
        // The half-sentence from the failed attempt was never committed —
        // the runtime appends only after a clean stream, and the retry must
        // not have introduced a second copy of the reply.
        let replies = session
            .messages()
            .iter()
            .filter(|m| m.role == MessageRole::Assistant)
            .count();
        assert_eq!(replies, 1, "the discarded fragment must not enter history");
    }

    #[tokio::test(start_paused = true)]
    async fn the_frontend_is_told_to_drop_the_partial_reply_before_a_retry() {
        let api = Arc::new(DropsThenAnswersApi::new(
            1,
            ApiError::Network("connection reset".into()),
        ));
        let runtime =
            ConversationRuntime::new(api, Arc::new(ToolRegistry::new()), RuntimeConfig::default());

        let mut session = Session::new("t-discard");
        let (tx, mut rx) = mpsc::channel(64);
        runtime
            .run_turn(
                &mut session,
                user_msg("check project"),
                tx,
                CancellationToken::new(),
            )
            .await
            .expect("turn should recover");

        let mut discards = Vec::new();
        let mut deltas_before_discard = 0_u32;
        while let Ok(Some(envelope)) =
            tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
        {
            match envelope.event {
                AssistantEvent::TextDelta { .. } if discards.is_empty() => {
                    deltas_before_discard += 1;
                }
                AssistantEvent::PartialReplyDiscarded {
                    attempt,
                    max_attempts,
                    ref reason,
                } => discards.push((attempt, max_attempts, reason.clone())),
                _ => {}
            }
        }

        assert_eq!(
            deltas_before_discard, 1,
            "the failed attempt's text really did reach the frontend",
        );
        assert_eq!(discards.len(), 1, "exactly one discard, for the one retry");
        let (attempt, max_attempts, reason) = discards.remove(0);
        assert_eq!(attempt, 1, "the attempt that failed, 1-based");
        assert_eq!(max_attempts, MAX_STREAM_ATTEMPTS);
        assert!(
            reason.contains("connection reset"),
            "the discard must carry why, got {reason}",
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retrying_stops_at_the_attempt_ceiling() {
        let api = Arc::new(DropsThenAnswersApi::new(
            u32::MAX,
            ApiError::Network("connection reset".into()),
        ));
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let mut session = Session::new("t-ceiling");
        let (tx, _rx) = mpsc::channel(64);
        let result = runtime
            .run_turn(
                &mut session,
                user_msg("check project"),
                tx,
                CancellationToken::new(),
            )
            .await;

        assert!(result.is_err(), "a failure that never clears must surface");
        assert_eq!(
            api.call_count(),
            MAX_STREAM_ATTEMPTS,
            "the ceiling is a ceiling — no spinning",
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_the_provider_rejects_is_not_retried() {
        // The 404 from `aurora.log`: a model routed to a backend that will
        // not take tools. Identical on every attempt, so retrying it only
        // spends the user's time.
        let api = Arc::new(DropsThenAnswersApi::new(
            u32::MAX,
            ApiError::InvalidRequest("HTTP 404: capability not supported".into()),
        ));
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let mut session = Session::new("t-invalid");
        let (tx, _rx) = mpsc::channel(64);
        let result = runtime
            .run_turn(
                &mut session,
                user_msg("check project"),
                tx,
                CancellationToken::new(),
            )
            .await;

        assert!(result.is_err());
        assert_eq!(api.call_count(), 1, "a rejected request shape fails once");
    }

    #[tokio::test(start_paused = true)]
    async fn stop_during_the_backoff_ends_the_turn_immediately() {
        // Cancelling mid-wait must not make the user sit out the rest of it,
        // and must report as a cancellation rather than the network error
        // that started the backoff.
        let api = Arc::new(DropsThenAnswersApi::new(
            u32::MAX,
            ApiError::Network("connection reset".into()),
        ));
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        tokio::spawn(async move {
            // Long enough that the first attempt has failed and the runtime
            // is inside the backoff; shorter than the 1s wait itself.
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            cancel_for_task.cancel();
        });

        let mut session = Session::new("t-stop");
        let (tx, _rx) = mpsc::channel(64);
        let result = runtime
            .run_turn(&mut session, user_msg("check project"), tx, cancel)
            .await;

        // Same shape a Stop *during* the stream produces — `is_cancellation`
        // is what the callers check, and both routes must satisfy it.
        match result {
            Err(ref e) if e.is_cancellation() => {}
            other => panic!("expected a cancellation, got {other:?}"),
        }
        assert_eq!(api.call_count(), 1, "the retry must never have been issued");
    }

    /// Always blockless — the condition really is persistent.
    #[derive(Default)]
    struct AlwaysEmptyApi {
        calls: Mutex<u32>,
    }

    #[async_trait]
    impl StreamingApiClient for AlwaysEmptyApi {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            *self.calls.lock().expect("calls") += 1;
            Ok(turn_usage(
                ConversationMessage::assistant(Vec::new(), 0),
                "end_turn",
            ))
        }
    }

    #[tokio::test]
    async fn a_persistently_empty_provider_is_reported_not_looped_on() {
        let api = Arc::new(AlwaysEmptyApi::default());
        let runtime = ConversationRuntime::new(
            api.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig::default(),
        );

        let mut session = Session::new("t-empty-always");
        let (tx, _rx) = mpsc::channel(64);
        runtime
            .run_turn(&mut session, user_msg("hi"), tx, CancellationToken::new())
            .await
            .expect("turn ends cleanly");

        assert_eq!(
            *api.calls.lock().expect("calls"),
            2,
            "exactly one retry — a second empty reply is a condition, not a loop",
        );
        assert!(
            session
                .messages()
                .iter()
                .any(|m| matches!(m.blocks.first(), Some(ContentBlock::Notice { .. }))),
            "the user must be told once the retry has also failed",
        );
    }

    #[test]
    fn a_measured_request_counts_cache_writes_and_output() {
        // Every slice of the prompt, plus the completion that becomes input on
        // the next request. Dropping cache-write here understated a
        // cache-writing turn by most of its prompt.
        assert_eq!(
            measured_context_tokens(&measured(10_000, 40_000, 5_000, 700)),
            55_700
        );
    }

    /// A runtime with no tools and no system prompt, so the from-scratch
    /// fallback is purely the message estimate and the two paths are easy to
    /// tell apart in an assertion.
    fn bare_runtime() -> ConversationRuntime {
        ConversationRuntime::new(
            recording_api("ok"),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                context_window: Some(500_000),
                ..RuntimeConfig::default()
            },
        )
    }

    #[tokio::test]
    async fn context_size_anchors_on_the_last_measured_request() {
        let runtime = bare_runtime();
        let mut session = Session::new("t-anchor");
        // A long history whose from-scratch estimate is nowhere near the
        // measured number — this is the situation that produced the 431k
        // report for a 180k context.
        let big = FILLER_60.repeat(50);
        session.append_message(user_with_text(&big, 0));
        let mut answered = assistant_with_text("done", 1);
        answered.usage = Some(measured(120_000, 0, 30_000, 500));
        session.append_message(answered);

        // Nothing added since the measurement → the anchor IS the answer.
        assert_eq!(runtime.projected_request_tokens(&session), 150_500);

        // One new message → anchor plus exactly that message's estimate.
        let follow_up = user_with_text("what about the other file?", 2);
        let delta = estimate_message_tokens(&follow_up, ReasoningReplay::Dropped);
        session.append_message(follow_up);
        assert_eq!(runtime.projected_request_tokens(&session), 150_500 + delta);
    }

    #[tokio::test]
    async fn our_own_estimate_is_never_used_as_an_anchor() {
        let runtime = bare_runtime();
        let mut session = Session::new("t-anchor-est");
        session.append_message(user_with_text("hello", 0));
        let mut guessed = assistant_with_text("hi", 1);
        // A no-usage provider's synthetic figure. Anchoring on it would
        // launder a guess into "measured" and freeze it as ground truth.
        guessed.usage = Some(TokenUsage {
            input_tokens: 999_999,
            output_tokens: 0,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            estimated: Some(true),
            cost_usd: None,
        });
        session.append_message(guessed);

        let projected = runtime.projected_request_tokens(&session);
        assert!(
            projected < 1_000,
            "should fall back to estimating the transcript, got {projected}",
        );
    }

    #[tokio::test]
    async fn context_size_falls_back_to_estimation_with_no_measurement() {
        let runtime = bare_runtime();
        let mut session = Session::new("t-anchor-none");
        session.append_message(user_with_text("hello", 0));
        session.append_message(assistant_with_text("hi", 1));

        let expected: u32 = session
            .messages()
            .iter()
            .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
            .fold(0, u32::saturating_add);
        assert_eq!(runtime.projected_request_tokens(&session), expected);
    }

    /// Summarizer that always comes back empty — the "compaction can never
    /// succeed for this conversation" case.
    #[derive(Default)]
    struct FailingSummarizer {
        calls: Mutex<u32>,
    }

    #[async_trait]
    impl StreamingApiClient for FailingSummarizer {
        async fn stream(
            &self,
            _request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            *self.calls.lock().expect("calls") += 1;
            Ok(turn_usage(assistant_text(""), "end_turn"))
        }
    }

    #[tokio::test]
    async fn auto_compaction_stops_retrying_a_failure_that_never_clears() {
        let summarizer = Arc::new(FailingSummarizer::default());
        let runtime = ConversationRuntime::new(
            recording_api("chat"),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                // A window small enough that the seeded transcript is always
                // over the threshold, so every attempt re-qualifies.
                context_window: Some(1_000),
                compaction_threshold: Some(0.5),
                ..RuntimeConfig::default()
            },
        )
        .with_compaction_client(summarizer.clone(), "summarizer:model");

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;

        // Ten turns' worth of attempts. Each failed compaction re-sends the
        // whole head, so an unbounded loop bills full price every turn.
        for _ in 0..10 {
            runtime
                .maybe_compact(
                    &mut session,
                    "turn",
                    &mut seq,
                    &tx,
                    &CancellationToken::new(),
                )
                .await;
        }

        let calls = *summarizer.calls.lock().expect("calls");
        assert_eq!(
            calls, MAX_CONSECUTIVE_COMPACTION_FAILURES,
            "breaker must stop after {MAX_CONSECUTIVE_COMPACTION_FAILURES} failures, made {calls}",
        );
        assert!(
            session.compaction_retry_after.is_some(),
            "cooldown must be armed"
        );
    }

    #[tokio::test]
    async fn a_manual_compact_is_not_blocked_by_the_breaker() {
        let summarizer = Arc::new(FailingSummarizer::default());
        let runtime = ConversationRuntime::new(
            recording_api("chat"),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                context_window: Some(1_000),
                compaction_threshold: Some(0.5),
                ..RuntimeConfig::default()
            },
        )
        .with_compaction_client(summarizer.clone(), "summarizer:model");

        let mut session = compactable_session();
        // Already tripped and cooling down.
        session.compaction_failures = MAX_CONSECUTIVE_COMPACTION_FAILURES;
        session.compaction_retry_after = Some(Utc::now().timestamp_millis() + 60_000);

        let (tx, _rx) = mpsc::channel(64);
        let mut seq = 0;
        let _ = runtime
            .compact_now(
                &mut session,
                "turn",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;

        // The user asked for this one and is watching it — it must run.
        assert_eq!(*summarizer.calls.lock().expect("calls"), 1);
    }

    /// API mock that answers with a fixed body and records the model it was
    /// asked for. Two of these let a test tell the chat provider apart from
    /// the summarizer.
    #[derive(Default)]
    struct ModelRecordingApi {
        reply: String,
        models: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl StreamingApiClient for ModelRecordingApi {
        async fn stream(
            &self,
            request: ApiRequest<'_>,
            _event_sink: mpsc::Sender<AssistantEvent>,
            _cancel_token: CancellationToken,
        ) -> Result<TurnUsage, ApiError> {
            self.models
                .lock()
                .expect("models")
                .push(request.model.to_string());
            Ok(turn_usage(assistant_text(&self.reply), "end_turn"))
        }
    }

    fn recording_api(reply: &str) -> Arc<ModelRecordingApi> {
        Arc::new(ModelRecordingApi {
            reply: reply.to_string(),
            models: Mutex::new(Vec::new()),
        })
    }

    /// A transcript long enough for `compaction_cut` to find a safe boundary:
    /// it needs at least two user messages with a non-empty head.
    fn compactable_session() -> Session {
        let big = FILLER_60.repeat(20);
        let mut session = Session::new("t-compact").with_model("chat-provider:chat-model");
        for turn in 0..4 {
            session.append_message(user_with_text(&big, turn * 2));
            session.append_message(assistant_with_text(&big, turn * 2 + 1));
        }
        session
    }

    /// The verbatim tail is bounded by an absolute token budget, never by a
    /// share of the window.
    ///
    /// This is the regression. The budget used to be 30% of the window, so a
    /// 1.1M-context chat was authorised to keep a 330k tail — compaction took
    /// a 382k request down to 204k, called it done, and the user paid to send
    /// 204k on every request afterwards. The arithmetic was never wrong; the
    /// number it was given was.
    #[test]
    fn the_preserved_tail_is_capped_in_tokens_not_in_window_share() {
        let big = FILLER_60.repeat(40);
        let mut messages = Vec::new();
        for turn in 0..60 {
            messages.push(user_with_text(&big, turn * 2));
            messages.push(assistant_with_text(&big, turn * 2 + 1));
        }
        let total: u32 = messages
            .iter()
            .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
            .fold(0, u32::saturating_add);
        assert!(
            total > 2 * COMPACT_TAIL_MAX_TOKENS,
            "the fixture has to be big enough for the cap to bite (got {total})",
        );

        let tail_for = |window: u32| -> u32 {
            let cut = compaction_cut(&messages, window, ReasoningReplay::Dropped)
                .expect("a transcript this long always has a safe cut");
            messages[cut..]
                .iter()
                .map(|m| estimate_message_tokens(m, ReasoningReplay::Dropped))
                .fold(0, u32::saturating_add)
        };

        // The window that produced the bug. 30% of it was 330,000 tokens.
        assert!(
            tail_for(1_100_000) <= COMPACT_TAIL_MAX_TOKENS,
            "a huge window must not authorise a huge tail",
        );
        // Every window large enough for the flat cap cuts in the SAME place —
        // the window no longer has a vote in how much history survives.
        assert_eq!(tail_for(1_100_000), tail_for(200_000));
        // A window too small for the flat cap scales down, and only down.
        assert!(tail_for(32_000) <= 32_000 / COMPACT_TAIL_WINDOW_DIVISOR);
    }

    #[tokio::test]
    async fn compaction_summarizes_on_the_chat_model_by_default() {
        let chat = recording_api("a summary");
        let runtime = ConversationRuntime::new(
            chat.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                context_window: Some(4000),
                ..RuntimeConfig::default()
            },
        );

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(32);
        let mut seq = 0;
        let result = runtime
            .compact_now(
                &mut session,
                "turn-1",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;

        assert!(result.is_some(), "compaction should have produced a marker");
        assert_eq!(
            chat.models.lock().expect("models").as_slice(),
            &["chat-provider:chat-model".to_string()],
            "with nothing pinned the summary rides the conversation's own model",
        );
    }

    #[tokio::test]
    async fn a_pinned_compaction_model_runs_and_is_billed_for_the_summary() {
        let chat = recording_api("chat reply");
        let summarizer = recording_api("a summary");
        let runtime = ConversationRuntime::new(
            chat.clone(),
            Arc::new(ToolRegistry::new()),
            RuntimeConfig {
                context_window: Some(4000),
                ..RuntimeConfig::default()
            },
        )
        .with_compaction_client(summarizer.clone(), "cheap-provider:cheap-model");

        let mut session = compactable_session();
        let (tx, _rx) = mpsc::channel(32);
        let mut seq = 0;
        let result = runtime
            .compact_now(
                &mut session,
                "turn-1",
                &mut seq,
                &tx,
                &CancellationToken::new(),
            )
            .await;

        assert!(result.is_some(), "compaction should have produced a marker");
        // The summary ran on the pinned provider…
        assert_eq!(
            summarizer.models.lock().expect("models").as_slice(),
            &["cheap-provider:cheap-model".to_string()],
        );
        // …and the chat provider was never asked to do it.
        assert!(
            chat.models.lock().expect("models").is_empty(),
            "the chat model must not run the summary once one is pinned",
        );

        // The marker carries the SUMMARIZER's model, so the cost card prices
        // this request at the cheap model's rates rather than the chat one's.
        let marker = session
            .messages()
            .iter()
            .find(|m| {
                m.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Compaction { .. }))
            })
            .expect("marker was inserted");
        assert_eq!(marker.model.as_deref(), Some("cheap-provider:cheap-model"));
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
