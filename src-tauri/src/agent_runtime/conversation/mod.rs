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

use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::api_client::{ApiError, ApiRequest, ReasoningConfig, StreamingApiClient, ToolSchema};
use super::error::RuntimeError;
use super::events::{AssistantEvent, TurnCompletion};
use super::hooks::{Hook, NoopHook, ToolHookResult};
use super::ipc::AgentEventEnvelope;
use super::session::{RichToolResult, Session};
use super::tool_bridge::{
    BridgeReply, BridgeRequest, BridgeToolCall, BridgeToolResult, ToolBridge,
};
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
/// Six, not three. Three attempts spanning three seconds is enough for a
/// packet loss and nothing else: a gateway rotating a bad upstream, a provider
/// shedding load, a laptop waking its wifi all take longer than that, and every
/// one of them used to end the turn and wait for the user to press Retry.
///
/// The cost of raising it is bounded and visible. Each wait emits
/// [`AssistantEvent::PartialReplyDiscarded`], so the user watches the attempts
/// rather than staring at a frozen window, and the backoff is interruptible, so
/// Stop lands immediately instead of after the sleep. Six attempts is ~31s of
/// waiting in the worst case (see [`STREAM_RETRY_BASE_DELAY_MS`]) — past that a
/// failure is an outage worth reporting, not a blip worth waiting out.
const MAX_STREAM_ATTEMPTS: u32 = 6;

/// One free request rebuild after an endpoint teaches Aurora a lower context
/// ceiling. The rebuild uses deterministic API-view trimming; it never starts
/// another paid summary request from the overflow error path.
const MAX_OVERFLOW_REBUILDS: u32 = 1;

/// Base backoff before re-issuing a failed model call, doubling per attempt:
/// 1s, 2s, 4s, 8s, 16s. At [`MAX_STREAM_ATTEMPTS`] = 6 that is 31s of waiting
/// across a fully-failed call, on top of the attempts themselves.
///
/// Starting at a second rather than immediately: a gateway swapping to a
/// healthy upstream needs a moment, and an instant retry usually just
/// buys the same error. Doubling rather than flat: if the first wait was
/// not enough, the second almost certainly needs to be longer.
const STREAM_RETRY_BASE_DELAY_MS: u64 = 1_000;

/// Ceiling on one backoff step.
///
/// The ladder is only reached when the provider gave us no `Retry-After` to
/// obey, so it is a guess by construction. Past half a minute a longer guess
/// stops being a retry and starts being a hang.
const STREAM_RETRY_MAX_DELAY_MS: u64 = 32_000;

/// Fraction of each backoff added as random jitter.
///
/// Without it every Aurora window that lost the same gateway retries on the
/// same schedule and arrives together, which is how a provider recovering from
/// load gets knocked over again by the clients waiting for it. A quarter is the
/// usual spread and matches the reference implementation.
const STREAM_RETRY_JITTER_FRACTION: f64 = 0.25;

/// How long to wait before re-issuing a failed model call.
///
/// `retry_after` is the provider's own answer, already clamped when it was
/// parsed. It wins outright: a 429 that says "60 seconds" means the ladder's
/// guess of two is wrong, and obeying it is the difference between clearing the
/// limit and extending it.
///
/// Everything else gets exponential backoff, capped, plus jitter.
fn stream_retry_delay_ms(attempt: u32, retry_after: Option<u64>) -> u64 {
    if let Some(secs) = retry_after {
        return secs.saturating_mul(1_000);
    }
    let stepped = STREAM_RETRY_BASE_DELAY_MS
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(STREAM_RETRY_MAX_DELAY_MS)
        .min(STREAM_RETRY_MAX_DELAY_MS);
    // `rand` is already in the tree; a fresh thread-local draw per call is
    // exactly the independence the jitter is for.
    let jitter = (stepped as f64 * STREAM_RETRY_JITTER_FRACTION * rand::random::<f64>()) as u64;
    stepped.saturating_add(jitter)
}

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
/// `system_prompt`, `temperature`, `max_output_tokens`, and the canonical
/// reasoning contract before constructing the runtime.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// The model id to put on the wire this turn.
    ///
    /// Separate from the model the conversation is **pinned** to, because on
    /// one provider they are different strings. Cursor writes the effort tier
    /// and the Fast lane into its model *id*, so the frontend composes
    /// `composer-2.5` plus the user's choices into `composer-2.5-fast` for the
    /// request, while the pin stays `cursor:composer-2.5` — the model itself,
    /// which is what the picker lists and what every capability lookup keys on.
    ///
    /// The runtime used to read the model back out of `Session::model` for
    /// this. That worked only while the two were the same string: the moment
    /// the pin became the undecorated id, the composed one was discarded and
    /// the account was sent a model that does not exist.
    ///
    /// Empty falls back to the session's pin, which is what every caller that
    /// does not set this relies on.
    pub wire_model: String,

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

    /// Provider-neutral reasoning intent for the selected model. This one
    /// value feeds every iteration, retry, and cache-sharing compaction call.
    pub reasoning: ReasoningConfig,

    /// Default sampling temperature applied to every API call.
    /// `None` defers to the provider preset (some, like DeepSeek's
    /// reasoner, ignore the field entirely). Phase 2.3 lets the
    /// per-turn `AgentChatRequest::temperature` override this.
    pub default_temperature: Option<f32>,

    /// Provider's advertised context window for the chosen model.
    /// `None` disables budget-aware trimming entirely (legacy
    /// behaviour: send the whole session every iteration).
    ///
    /// When `Some(window)`, the runtime trims older messages from the
    /// API view before each call so the request stays under
    /// ~75% of `window - default_max_output_tokens * 1.1`. The
    /// persisted JSONL is untouched — trim is purely an API-view
    /// concern, mirroring how the repo map is injected.
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

    /// How far outside the project this turn's file tools may reach — the
    /// user's choice in Settings → Tools. See
    /// [`crate::agent_runtime::tool_executor::WorkspaceAccess`].
    pub workspace_access: crate::agent_runtime::tool_executor::WorkspaceAccess,
    /// Is this turn running in Aurora Chat?
    ///
    /// The runtime needs the mode for exactly one decision — what goes in the
    /// first message's head block: chat gets `<memory>`, the project modes get
    /// `<machine_tools>` and `<repo_map>`. Carried as a bool rather than the
    /// whole `AgentExecutionMode` so this crate's conversation layer does not
    /// grow a dependency on the IPC enum for one branch.
    pub execution_mode_is_chat: bool,

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
            wire_model: String::new(),
            max_iterations: None,
            system_prompt: None,
            // Reasoning tokens bill against the output cap on every provider
            // except Anthropic (whose budget is added on top — see
            // `anthropic_max_tokens_with_thinking`). At 8k a high reasoning
            // effort could consume the entire allowance before the model wrote
            // a word, ending the turn at the cap with nothing to show. The
            // extra headroom costs ~9k of trim reserve on a 200k window.
            default_max_output_tokens: 16_384,
            reasoning: ReasoningConfig::default(),
            default_temperature: None,
            context_window: None,
            compaction_threshold: None,
            // Covers the `<analysis>` drafting pass AND the note itself — see
            // `COMPACTION_SYSTEM_PROMPT`. Too small and the scratchpad starves
            // the note of its last, most important sections.
            compaction_summary_budget: 16_000,
            workspace_access: crate::agent_runtime::tool_executor::WorkspaceAccess::Workspace,
            execution_mode_is_chat: false,
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
    /// How that store arranges a thread's files, which decides where the spill
    /// directory sits. Carried rather than inferred: `delete` derives the same
    /// path from the store itself, and a guess made here that disagreed would
    /// leave spilled output behind after a conversation was removed.
    store_layout: super::session_store::StoreLayout,
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
    /// Aurora Chat's `<memory>` block, memoized for the life of the
    /// conversation for the same cache reason `repo_map` is: it rides in the
    /// first user message, which is the head of every request's cacheable
    /// prefix, so it must be byte-identical on every turn.
    memory: Arc<std::sync::OnceLock<Option<String>>>,
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
            store_layout: super::session_store::StoreLayout::Flat,
            compaction_client: None,
            tool_schema_tokens: Arc::new(std::sync::OnceLock::new()),
            repo_map: Arc::new(std::sync::OnceLock::new()),
            memory: Arc::new(std::sync::OnceLock::new()),
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

    /// Point the runtime at a whole store, taking its directory AND its layout.
    ///
    /// Prefer this over [`Self::with_store_dir`] wherever the store itself is
    /// in hand. The directory alone is not enough to place spilled output once
    /// two layouts exist, and the flat default is only right by accident for a
    /// chat conversation.
    #[must_use]
    pub fn with_store(mut self, store: &super::session_store::SessionStore) -> Self {
        self.store_dir = Some(store.dir().to_path_buf());
        self.store_layout = store.layout();
        self
    }

    /// Move oversized payloads in `raw` onto disk, returning the content with
    /// a head+tail preview and the file's path. A no-op without a store dir.
    ///
    /// `tool` decides where the spill fires: the clamp that runs immediately
    /// after this uses a per-tool cap, and a spill later than that cap cuts
    /// output with no path to the rest. See
    /// [`super::tool_spill::spill_under_clamp`].
    fn spill_tool_output(
        &self,
        session: &Session,
        tool: &str,
        tool_call_id: &str,
        raw: String,
    ) -> String {
        let Some(root) = self.store_dir.as_deref() else {
            return raw;
        };
        let dir = super::session_store::tool_results_dir_in(root, &session.thread_id, self.store_layout);
        let clamp_keeps = tool_results::result_cap_for(tool)
            .saturating_sub(tool_results::TRUNCATION_MARKER_RESERVE);
        super::tool_spill::spill_under_clamp(&dir, tool_call_id, raw, clamp_keeps)
    }

    /// [`Self::spill_tool_output`] at the budget's lower floor.
    ///
    /// Called only when one tool message's results together exceed
    /// [`MAX_TOOL_RESULTS_PER_MESSAGE`]. Returns `raw` untouched without a
    /// store dir, or when the spill declines it — the budget reads that as an
    /// exemption rather than a failure.
    fn spill_for_budget(&self, session: &Session, tool_call_id: &str, raw: String) -> String {
        let Some(root) = self.store_dir.as_deref() else {
            return raw;
        };
        let dir = super::session_store::tool_results_dir_in(root, &session.thread_id, self.store_layout);
        super::tool_spill::spill_for_budget(&dir, tool_call_id, raw)
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

        // 1. Record the user input in history, with Aurora's context for it
        //    attached ONCE, now. The caller put the frontend's part (open
        //    files, selection, an attached rule) on the message; the checklist
        //    as it stands is added here, where the store is. Whatever the
        //    frontend sent is treated as the block's content, so a message
        //    that arrives already carrying one is left alone.
        let mut user_message = user_message;
        if user_message.role == MessageRole::User {
            user_message.aurora_context =
                self.user_message_context(user_message.aurora_context.as_deref(), &session.thread_id);
        }
        session.append_message(user_message);

        let mut iterations: u32 = 0;
        // One free re-issue when the provider hands back a response with no
        // content blocks at all. See the empty-reply branch below.
        let mut retried_empty_reply = false;
        // A provider overflow may teach us a smaller endpoint limit once. The
        // next iteration rebuilds through deterministic trim; no paid summary
        // is launched from the error path.
        let mut overflow_rebuilds: u32 = 0;
        // Automatic compaction may make at most one provider request in one
        // user turn, even if many tool iterations grow past the threshold.
        let mut auto_compaction_attempted = false;
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
            if !auto_compaction_attempted {
                auto_compaction_attempted = self
                    .maybe_compact(session, &turn_id, &mut seq, &event_sink, &cancel_token)
                    .await;
            }

            // ── Stream one assistant message ───────────────────────
            //
            // The pin. What this conversation is ON — the key the frontend's
            // capability lookups use, and what the learned context limits below
            // are filed under.
            let model = session.model.clone().unwrap_or_default();
            // What actually goes on the wire, which is not always the same
            // string: Cursor's effort tier and Fast lane live in its model id,
            // so the frontend composes them in before sending. Falling back to
            // the pin keeps every caller that sets no wire model working
            // exactly as before.
            let wire_model = if self.config.wire_model.is_empty() {
                model.clone()
            } else {
                self.config.wire_model.clone()
            };
            let tool_schemas = self.tools.schemas();

            // The event channel and its forwarder are built per *attempt*,
            // down in the retry loop — a forwarder ends with the stream that
            // feeds it, so a retry needs a fresh pair.

            // Apply any persisted compaction first: replace everything at
            // or older than the last compaction marker with its summary,
            // keeping the verbatim tail. The persisted JSONL keeps the full
            // history (the UI shows it); only this API view shrinks — the
            // same contract the repo map and `trim` follow. A no-marker
            // session round-trips unchanged.
            //
            // Then put each user message's saved context after its text.
            // Deterministic per message, so the same history always renders
            // the same bytes — see `fold_message_context`.
            let compacted = fold_message_context(&self.compacted_view(session));

            // Orientation: for the workspace, what exists and roughly where.
            // The map is built from the same index the `code` tool reads, so
            // the two can never describe different codebases. Byte-stable for
            // the whole conversation (see `REPO_MAP_BY_THREAD`) because it
            // rides in the FIRST user message — the start of the provider's
            // cached prefix.
            //
            // Failure here is silent by design — it is a convenience, and an
            // unindexable workspace must not cost the user their turn. The
            // agent still has `code`, `grep`, `workspace_tree`, and the shell.
            let owned_messages: Option<Vec<ConversationMessage>> = match self
                .head_context_block(session.workspace_root.as_deref(), &session.thread_id)
            {
                Some(block) => Some(inject_repo_map(&compacted, &block)),
                None => None,
            };

            // Budget-aware trim. Same API-view-only contract as the repo map:
            // persisted session stays whole, only the request body shrinks.
            // Disabled (no-op) when `context_window` is `None`.
            let trim_input: Vec<ConversationMessage> = owned_messages.unwrap_or(compacted);
            let effective_context_window = crate::agent_runtime::context_limits::effective_window(
                &model,
                self.config.context_window,
            );
            // The system prompt every request carries: the composed prompt
            // plus `<machine_tools>`. Built once per iteration and shared with
            // the trim estimate below, so what is counted is what is sent.
            let base_system_prompt = self.request_system_prompt(&session.thread_id);
            let trim_outcome = trim_to_budget(
                trim_input,
                effective_context_window,
                self.config.default_max_output_tokens,
                base_system_prompt.as_deref().unwrap_or(""),
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

            // Nothing is appended past this point. Every request ends on a
            // message that is already in the transcript exactly as sent, so
            // there is no volatile tail and the provider's cache breakpoint
            // sits on the last message. The state block that used to ride
            // here — as its own user turn, then inside the newest tool result
            // — is gone: what it carried is saved on the user's message
            // (`aurora_context`) and, rarely, in a stale-checklist reminder
            // written into a tool result once (`stale_checklist_reminder`).
            let final_messages = repair.messages;
            let messages_for_api: &[ConversationMessage] = &final_messages;

            // When the trim dropped messages, append a small notice to
            // the system prompt so the model knows the early conversation
            // has been omitted (and won't hallucinate having seen it).
            let trim_notice: String;
            let system_prompt: Option<&str> = if trim_outcome.dropped > 0 {
                trim_notice = build_trim_notice(
                    base_system_prompt.as_deref().unwrap_or(""),
                    trim_outcome.dropped,
                );
                Some(trim_notice.as_str())
            } else {
                base_system_prompt.as_deref()
            };

            // ── The model call, with retry ─────────────────────────
            //
            // A dropped connection was the single most common real failure
            // on this runtime, and every one of them ended the turn and
            // waited for the user to notice and press Retry by hand. The
            // request is rebuilt byte-identical on each attempt, so the
            // retry re-reads the provider's prompt cache rather than paying
            // for a fresh prompt.
            // Set once this request has run tools on its open stream, which
            // changes two later decisions — see the retry guard and the
            // empty-reply check below.
            let mut bridge_served = false;
            let mut attempt: u32 = 1;
            // Owned copy: the request borrows it across the stream await,
            // where `session` itself must stay mutably borrowable for the
            // tool bridge.
            let thread_key = session.thread_id.clone();
            let stream_result = loop {
                // Internal event channel: API impl pushes `AssistantEvent`
                // onto `api_tx`; a forwarder task wraps each in an envelope
                // and pushes it onto the caller's sink. Rebuilt per attempt,
                // starting from the `seq` the previous attempt reached so
                // the frontend's ordering stays monotonic across a retry.
                let (api_tx, api_rx) = mpsc::channel::<AssistantEvent>(64);
                // One counter for everything this attempt emits. A
                // bidirectional provider runs tools while the stream is still
                // streaming, so the forwarder and the tool path have to draw
                // from the same number — see `spawn_event_forwarder`.
                let shared_seq = Arc::new(AtomicU64::new(seq));
                let forwarder = spawn_event_forwarder(
                    turn_id.clone(),
                    Arc::clone(&shared_seq),
                    api_rx,
                    event_sink.clone(),
                );

                // Capacity 1 on purpose: the adapter is blocked on its own
                // request until we answer it, so a deeper queue could only
                // hide a protocol bug. Rebuilt per attempt — a retry opens a
                // new stream, and results owed to the dead one are owed to
                // nobody.
                let (bridge_tx, mut bridge_rx) = mpsc::channel::<BridgeRequest>(1);
                let bridge = ToolBridge::new(bridge_tx);

                // Borrows only — rebuilding it per attempt costs nothing.
                let request = ApiRequest {
                    model: &wire_model,
                    system_prompt,
                    messages: messages_for_api,
                    tools: &tool_schemas,
                    tool_choice: Default::default(),
                    temperature: self.config.default_temperature,
                    max_output_tokens: self.config.default_max_output_tokens,
                    reasoning: self.config.reasoning.as_request(),
                    tool_bridge: Some(&bridge),
                    // Cache affinity: same conversation, same key, same
                    // provider-side cache node (OpenAI `prompt_cache_key`,
                    // Codex `session_id`).
                    session_key: Some(&thread_key),
                };

                // Drive the stream and serve its tool requests in the same
                // task. Adapters that never touch the bridge never take the
                // second branch, and behave exactly as they did before.
                //
                // Pausing the stream while a batch runs is correct rather than
                // merely tolerable: a provider that asked for a tool is
                // waiting on that answer and sending nothing meanwhile, and
                // the request body is flushed by the connection's own task, so
                // nothing needs us to poll here for the reply to go out.
                let result = {
                    let stream = self
                        .api_client
                        .stream(request, api_tx, cancel_token.clone());
                    tokio::pin!(stream);
                    loop {
                        tokio::select! {
                            biased;
                            finished = &mut stream => break finished,
                            Some(ask) = bridge_rx.recv() => {
                                bridge_served = true;
                                let reply = self
                                    .serve_tool_bridge(
                                        ask.assistant,
                                        ask.calls,
                                        session,
                                        &turn_id,
                                        &cancel_token,
                                        &event_sink,
                                        &shared_seq,
                                    )
                                    .await?;
                                // A dropped receiver means the adapter stopped
                                // waiting; the stream branch reports why.
                                let _ = ask.reply.send(reply);
                            }
                        }
                    }
                };

                // Drain the forwarder so everything it holds is out before we
                // read the counter it was drawing from.
                if let Err(join_err) = forwarder.await {
                    return Err(RuntimeError::InvalidState(format!(
                        "event forwarder task failed: {join_err}"
                    )));
                }
                seq = shared_seq.load(AtomicOrdering::Relaxed);

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
                //
                // A stream that already ran tools is never retried, whatever
                // the error. Retrying re-sends `messages_for_api`, which was
                // built before the turn started and therefore does not contain
                // the results those tools just wrote — so the model would be
                // asked to do the same work a second time with no memory of
                // the first. The turn ends here instead; the session holds the
                // completed work, and the next request is built from it.
                if attempt >= MAX_STREAM_ATTEMPTS || !api_err.is_retryable() || bridge_served {
                    break Err(api_err);
                }

                // A 429 carries the provider's own answer; everything else is
                // the capped, jittered ladder.
                let retry_after = match &api_err {
                    ApiError::RateLimit { retry_after_secs } => *retry_after_secs,
                    _ => None,
                };
                let delay_ms = stream_retry_delay_ms(attempt, retry_after);

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
                    // ── Context overflow: compact, then re-issue ────
                    //
                    // The provider has just told us the prompt is bigger than
                    // the model's real window. That answer outranks every
                    // number Aurora holds: the configured window said there
                    // was room, the threshold never fired, and the request
                    // still came back too large. So compaction runs here
                    // unconditionally — not at a percentage of a window we now
                    // know is wrong, and not subject to the usage threshold or
                    // the failure circuit breaker. `compact_now` is the same
                    // pass `/compact` runs, so the user sees the same card.
                    //
                    // Then `continue`, which rebuilds the whole request from
                    // the compacted session: retrying in place would resend
                    // the body that was just rejected.
                    if api_err.is_context_overflow() {
                        // Negative evidence, recorded whether or not there is
                        // any compaction budget left: this is the only moment
                        // the endpoint ever states its real ceiling, and the
                        // NEXT conversation on this provider should not have
                        // to be taught the same lesson. Approximate by
                        // necessity — the provider reports no size for a
                        // request it refused to run — and clamped inside
                        // `record_rejected` so one bad estimate cannot
                        // collapse the ceiling.
                        crate::agent_runtime::context_limits::record_rejected(
                            &model,
                            self.projected_request_tokens(session),
                        );
                    }
                    if api_err.is_context_overflow() && overflow_rebuilds < MAX_OVERFLOW_REBUILDS {
                        overflow_rebuilds = overflow_rebuilds.saturating_add(1);
                        // Do not let the loop top turn the newly learned lower
                        // ceiling into a paid auto-compaction. The rebuilt
                        // request is bounded by deterministic trim instead.
                        auto_compaction_attempted = true;
                        crate::logging::log_warn(
                            "agent_runtime.turn",
                            &format!(
                                "provider rejected turn {turn_id} (thread {}, model {model}) as \
                                 over its context window — the configured window is larger than \
                                 what this endpoint serves. Rebuilding once with deterministic \
                                 trim ({overflow_rebuilds}/{MAX_OVERFLOW_REBUILDS}) and \
                                 re-issuing without a paid compaction request: {api_err}",
                                session.thread_id,
                            ),
                        );
                        continue;
                    }

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
            // Positive evidence about what this endpoint actually serves. Only
            // a PROVIDER-measured size teaches the ceiling — an estimate here
            // would have Aurora learning its own guess, and Aurora's guess is
            // the thing that could not be trusted.
            if effective_usage.estimated != Some(true) {
                crate::agent_runtime::context_limits::record_accepted(
                    &model,
                    measured_context_tokens(&effective_usage),
                );
            }
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
            //
            // "No blocks" was too narrow. A stream that dies part-way through
            // the model's reasoning leaves ONE block — a thinking block, cut
            // mid-sentence — and that is not a reply either: it answers
            // nothing and calls nothing, so the turn has nowhere to go. Keying
            // the retry on emptiness meant the one case where retrying is
            // guaranteed safe was the one case that never retried.
            //
            // Not persisting it matters as much as retrying. A dead-end
            // thought in history is replayed to the provider on every later
            // request in the thread, so the truncation is paid for again and
            // again for reasoning that reached no conclusion.
            // On a provider that ran its tools mid-stream, an empty trailing
            // message is a normal way for a turn to end: the model's last act
            // was a tool call, and everything it said is already in the
            // session. It must not be mistaken for a provider that answered
            // with nothing — that would retry a turn which in fact succeeded.
            let trailing_is_empty = !can_advance_turn(&assistant_message);
            let produced_nothing = trailing_is_empty && !bridge_served;
            // Read before the message is moved below, and the distinction is
            // worth keeping: reasoning that stopped without concluding is a
            // cut stream, while nothing at all points at the provider or the
            // route.
            let stalled_after_reasoning = produced_nothing && has_thinking(&assistant_message);
            // Keyed on emptiness, not on `produced_nothing`: an empty message
            // must stay out of history either way — it serializes as an
            // assistant turn with no content, which Anthropic rejects outright
            // on every later request in the thread.
            if !trailing_is_empty {
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
                    "agent_runtime: reply cannot advance the turn — no text, no tool call \
                     (output_tokens={effective_usage_output}, \
                     thinking={stalled_after_reasoning}); retrying once"
                );
                // Reasoning that was cut off is already on screen, and the
                // retry streams from the top. Without this the user watches a
                // dead thought and its replacement stack up as two blocks, and
                // has no way to tell which one the answer came from. A truly
                // empty reply had nothing to discard, which is why this was
                // never needed before.
                if stalled_after_reasoning {
                    seq = seq.saturating_add(1);
                    let _ = event_sink
                        .send(AgentEventEnvelope {
                            turn_id: turn_id.clone(),
                            seq,
                            event: AssistantEvent::PartialReplyDiscarded {
                                attempt: 1,
                                max_attempts: 2,
                                reason: "the model stopped mid-reasoning without answering"
                                    .to_string(),
                            },
                        })
                        .await;
                }
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
                        aurora_context: None,
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
                // Two things ride this slot, and they are not the same kind of
                // thing. A person's message goes in as text on the tool message
                // — that is a message, and it belongs in the conversation as
                // one. A background process ending is not anybody's words, so
                // it goes in as its own block; that is what lets a RELOADED
                // thread still tell the two apart, which a display-only flag
                // could not (the flag lives in the event, the transcript is
                // rebuilt from the blocks).
                match queued.origin {
                    crate::agent_runtime::types::InjectedOrigin::Process => {
                        tool_msg.blocks.push(ContentBlock::ProcessEvent {
                            // The transcript's one line, in the checklist
                            // beat's shape; the model's copy keeps the ids.
                            summary: queued
                                .display_text
                                .clone()
                                .unwrap_or_else(|| queued.text.clone()),
                            detail: queued.text.clone(),
                            created_at: queued.queued_at_ms,
                        });
                    }
                    crate::agent_runtime::types::InjectedOrigin::User => {
                        // A composer mid-turn message gets the framing preamble
                        // so the model knows it arrived while the tools above
                        // were running — "don't run pnpm" landing after the
                        // lint output is otherwise a contradiction the model
                        // has to guess at.
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
                        // Composer pill metadata rides on the tool message
                        // itself, so a reload can re-render the injected row's
                        // chips — the same persistence channel a normal user
                        // message uses.
                        tool_msg.attached_prompt_chips = queued.chips.clone();
                    }
                }
                // The event carries the DISPLAY text: what the user typed,
                // not the model copy with the resolved directive block.
                let display = queued.display_text.unwrap_or(queued.text);
                let envelope = AgentEventEnvelope {
                    turn_id: turn_id.clone(),
                    seq,
                    event: AssistantEvent::QueuedMessageInjected {
                        text: display,
                        chips: queued.chips,
                        origin: queued.origin,
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
}

// ── Module map ──────────────────────────────────────────────────────────
//
// Everything below was split out of this file verbatim. Each child does
// `use super::*`, which is what keeps the original import surface intact:
// a child module can see its parent's private imports.

mod compaction;
pub(crate) mod context_injection;
#[cfg(test)]
mod tests;
mod tokens;
mod tool_dispatch;
mod tool_exec;
mod tool_result_budget;
mod tool_results;
mod trim;
mod util;

use context_injection::*;
use tokens::*;
use tool_exec::*;
use tool_result_budget::*;
use tool_results::*;
use trim::*;
use util::*;
