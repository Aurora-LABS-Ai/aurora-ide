//! Agent runtime — Running one batch of tool calls: concurrency grouping, dispatch, and the
//! failure paths that must still return a result block per call.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

impl ConversationRuntime {
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
    pub(super) fn concurrent_batch_len(&self, calls: &[PendingToolCall]) -> usize {
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
    pub(super) fn is_batchable(&self, call: &PendingToolCall) -> bool {
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
    ///
    /// **The UI is told about each call the moment that call finishes**, not
    /// when the batch does. Those are two different orderings and only the
    /// first one is a constraint: result blocks, the spill, and the rich
    /// sidecars all have to follow the model's call order, so they wait for
    /// the batch and are folded in sequence below. A tool card does not —
    /// it belongs to one call and nothing else reads it. Resolving them
    /// together meant the slowest tool in a group set every card's clock:
    /// three `grep`s that each finished in single-digit milliseconds sat
    /// spinning for the 24 seconds the `read_lints` beside them took, and a
    /// `file_read` looked slow when it had been done for half a minute.
    pub(super) async fn execute_tool_calls(
        &self,
        calls: Vec<PendingToolCall>,
        session: &Session,
        turn_id: &str,
        cancel_token: &CancellationToken,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        seq: &mut u64,
    ) -> Result<ToolBatchOutcome, RuntimeError> {
        let event_seq = AtomicU64::new(*seq);
        let outcome = self
            .execute_tool_calls_seq(
                calls,
                session,
                turn_id,
                cancel_token,
                event_sink,
                &event_seq,
            )
            .await;
        // Hand the counter back. Everything inside drew from `event_seq`, so
        // the caller's next event must continue from where it landed.
        *seq = event_seq.load(AtomicOrdering::Relaxed);
        outcome
    }

    /// [`Self::execute_tool_calls`] against a counter the caller owns.
    ///
    /// A bidirectional provider runs its tools while its stream is still open
    /// and still emitting, so the event counter has to be one both sides draw
    /// from rather than a number handed over and handed back. See
    /// [`crate::agent_runtime::tool_bridge`].
    pub(super) async fn execute_tool_calls_seq(
        &self,
        calls: Vec<PendingToolCall>,
        session: &Session,
        turn_id: &str,
        cancel_token: &CancellationToken,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        event_seq: &AtomicU64,
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
                    emit_native_tool_event_shared(
                        event_sink,
                        turn_id,
                        event_seq,
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
            // Borrowed once, outside the closure: an `async move` block that
            // mentioned the counter directly would move it, and there is one
            // counter for the whole turn.
            let seq_cell = event_seq;
            let outcomes =
                futures_util::future::join_all(batch.iter().zip(lifecycles.iter().copied()).map(
                    |(call, uses_frontend_lifecycle)| {
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
                                crate::agent_runtime::session_store::tool_results_dir_in(
                                    root,
                                    &session.thread_id,
                                )
                            }),
                            cancel_token: cancel_token.clone(),
                        };
                        async move {
                            // Three distinct failures, three distinct messages.
                            // Collapsing any two of them is what makes a capable
                            // model look erratic: it retries, rephrases, and
                            // switches tools because the error it got back does
                            // not describe what it actually did.
                            let outcome =
                                match crate::api::provider_kernel_adapter::malformed_tool_input(
                                    &call.input,
                                ) {
                                    // The arguments never survived the stream. Do NOT
                                    // dispatch: the executor would report a missing
                                    // field to a model that sent it. Quote back what
                                    // arrived so the model can see the truncation
                                    // point and re-emit.
                                    Some(raw) => Err(malformed_input_error(&call.name, raw)),
                                    None => match self.tools.get(&call.name) {
                                        Some(tool) => {
                                            tool.execute(call.input.clone(), &context).await
                                        }
                                        // Unknown name — hand back the nearest match and
                                        // the real roster so this costs one iteration,
                                        // not five.
                                        None => Err(self.tools.unknown_tool_error(&call.name)),
                                    },
                                };

                            // This call is done — say so now. See the note on this
                            // function: the fold below is ordered because the model's
                            // history has to be, and a card is not part of that.
                            //
                            // The repeat-failure escalation is deliberately absent
                            // here. It is an instruction addressed to the model ("do
                            // not issue this call again"), it is counted per batch in
                            // call order, and it belongs to the copy the model reads.
                            // The card shows the tool's own error, which is the part
                            // a person can act on.
                            if !uses_frontend_lifecycle {
                                let (content, is_error) = match &outcome {
                                    Ok(output) => (
                                        truncate_tool_content_for_ui(&call.name, output.clone()),
                                        false,
                                    ),
                                    Err(ToolError::Cancelled) => {
                                        (STOPPED_MID_RUN.to_string(), true)
                                    }
                                    Err(err) => (err.to_string(), true),
                                };
                                emit_native_tool_event_shared(
                                    event_sink,
                                    turn_id,
                                    seq_cell,
                                    AssistantEvent::ToolExecutionResult {
                                        id: call.id.clone(),
                                        name: call.name.clone(),
                                        input: call.input.clone(),
                                        content,
                                        is_error,
                                    },
                                )
                                .await;
                            }

                            outcome
                        }
                    },
                ))
                .await;

            // ── Fold ──────────────────────────────────────────────────
            // Sequential and in call order: session spill, rich sidecars,
            // and result blocks all depend on a stable order. The cards
            // have already resolved themselves above, each on its own
            // clock, so nothing here is on the critical path for the UI.
            for (call, outcome) in batch.iter().zip(outcomes) {
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
                    let ui_copy = truncate_tool_content_for_ui(&name, raw_content);
                    if ui_copy != history_content {
                        session.push_rich_result(RichToolResult {
                            tool_use_id: id.clone(),
                            tool: name.clone(),
                            content: ui_copy,
                        });
                    }
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
            // `fail_pending_tool_calls` counts with a plain `&mut u64`; borrow
            // the shared value across the call and put it back, so the two
            // numbering schemes stay one sequence.
            let mut tail_seq = event_seq.load(AtomicOrdering::Relaxed);
            let pending = self
                .fail_pending_tool_calls(
                    skipped,
                    STOPPED_BEFORE_RUN,
                    turn_id,
                    &mut tail_seq,
                    event_sink,
                )
                .await;
            event_seq.store(tail_seq, AtomicOrdering::Relaxed);
            result_blocks.extend(pending.blocks);
        }

        // ── Aggregate budget ──────────────────────────────────────────
        //
        // Every cap above is per CALL. Ten concurrent reads each returning a
        // legal 50 KiB is 500 KiB in this ONE message, and nothing so far has
        // looked at the sum. Bring it under the ceiling here, at assembly,
        // where the verdict is written into the message that gets persisted —
        // so it is byte-stable for the rest of the conversation and no later
        // pass can rewrite a cached prefix by changing its mind.
        if let Some(report) = enforce_message_budget(&mut result_blocks, |id, raw| {
            self.spill_for_budget(session, id, raw)
        }) {
            eprintln!(
                "agent_runtime: tool message over budget on turn {turn_id} \
                 ({} -> {} bytes, {} moved to disk, {} exempt)",
                report.before, report.after, report.spilled, report.exempt,
            );
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
    pub(super) async fn fail_pending_tool_calls(
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

    /// Answer one [`BridgeRequest`] from a provider whose stream is still open.
    ///
    /// This is the *only* extra path tools reach, and it deliberately does no
    /// tool work of its own — it writes the transcript and then calls the same
    /// [`Self::execute_tool_calls_seq`] the normal loop calls. That is what
    /// keeps the permission gate, the concurrency rules, the output caps and
    /// the rich sidecars identical on a bidirectional provider. Reimplementing
    /// any of it here would fork the gate, and a forked gate is one that stops
    /// asking before `shell_execute`.
    ///
    /// Ordering is the other half of the contract. The assistant message
    /// carrying the `tool_use` blocks is appended **before** the tools run, so
    /// the transcript never holds results whose call has not been written yet
    /// — which is also what keeps the per-message journal correct through a
    /// turn that now spans one long connection.
    pub(super) async fn serve_tool_bridge(
        &self,
        assistant: ConversationMessage,
        calls: Vec<BridgeToolCall>,
        session: &mut Session,
        turn_id: &str,
        cancel_token: &CancellationToken,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        event_seq: &AtomicU64,
    ) -> Result<BridgeReply, RuntimeError> {
        session.append_message(assistant);

        let pending: Vec<PendingToolCall> = calls
            .iter()
            .map(|call| PendingToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            })
            .collect();

        let batch = self
            .execute_tool_calls_seq(
                pending,
                session,
                turn_id,
                cancel_token,
                event_sink,
                event_seq,
            )
            .await?;

        // Read the answers back out of the message rather than tracking them
        // alongside it: the message is what the transcript and the provider
        // both see, and a second copy could disagree with it after the spill
        // rewrites an oversized result into a file path.
        let mut results = Vec::with_capacity(calls.len());
        for call in &calls {
            let found = batch.message.blocks.iter().find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } if *tool_use_id == call.id => Some((content.clone(), is_error.unwrap_or(false))),
                _ => None,
            });
            // Every call is answered by construction, so a miss is a bug rather
            // than a state to model. Still answered here: the far end is
            // holding a stream open on this id, and silence would hang it.
            let (content, is_error) = found.unwrap_or_else(|| {
                (
                    "This tool produced no result block, which is an Aurora bug.".to_string(),
                    true,
                )
            });
            results.push(BridgeToolResult {
                id: call.id.clone(),
                content,
                is_error,
            });
        }

        let cancelled = batch.cancelled;
        session.append_message(batch.message);

        Ok(BridgeReply { results, cancelled })
    }
}

/// One tool batch's worth of results, plus whether a cancellation cut it short.
///
/// The message is always complete — every call in it has a result block, real
/// or synthetic — so the caller can persist it before unwinding.
pub(super) struct ToolBatchOutcome {
    pub(super) message: ConversationMessage,
    pub(super) cancelled: bool,
}

/// One pending tool call extracted from an assistant message.
#[derive(Debug, Clone)]
pub(super) struct PendingToolCall {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) input: serde_json::Value,
}

/// Whether a stop reason means "cut off by the output cap".
///
/// Providers disagree on the spelling: Anthropic says `max_tokens`, the
/// OpenAI family says `length`. Both mean the reply is incomplete.
pub(super) fn is_length_stop(stop_reason: &str) -> bool {
    matches!(stop_reason, "length" | "max_tokens")
}

/// Tell the user (and the reloaded thread) that the reply was cut off by the
/// model's output cap.
///
/// Fires on BOTH length-stop paths — the reply that ended mid-sentence, and the
/// one that was cut while emitting tool calls. The second used to say nothing at
/// all: the tool batch was executed as if the model had finished asking for it,
/// so the only symptom was an agent that quietly did part of a job.
pub(super) async fn emit_truncation_notice(
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
pub(super) fn has_visible_answer(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        _ => false,
    })
}

/// Can this reply move the turn forward at all?
///
/// Text answers the user; a tool call continues the work. A message with
/// neither does neither, and re-issuing the request is the only thing that
/// helps.
///
/// Deliberately NOT [`has_visible_answer`], which counts text only: a message
/// carrying nothing but tool calls is a perfectly good step and must not be
/// mistaken for a dropped one.
///
/// Traced from a live session on 2026-08-23. The provider dropped a request
/// mid-stream — its own dashboard billed that call **zero tokens** — and
/// Aurora received a thinking block whose text stops mid-sentence. The retry
/// that exists for exactly this case was keyed on `blocks.is_empty()`, and the
/// message had one block, so it never fired: a truncated thought became the
/// end of the turn, and was persisted where it would be replayed to the
/// provider on every later request.
pub(super) fn can_advance_turn(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        ContentBlock::ToolUse { .. } => true,
        _ => false,
    })
}

/// Did the model produce reasoning but no answer?
///
/// Worth distinguishing, because the fix differs: reasoning-only means the
/// output cap or effort tier is wrong, while nothing-at-all points at the
/// provider or the route.
pub(super) fn has_thinking(message: &ConversationMessage) -> bool {
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
pub(super) struct FailureLoopGuard {
    failures: std::collections::HashMap<(String, String), u32>,
}

impl FailureLoopGuard {
    pub(super) fn key(tool: &str, input: &serde_json::Value) -> (String, String) {
        (tool.to_string(), input.to_string())
    }

    /// Record a failure and return the escalation to append, if any.
    pub(super) fn record_failure(
        &mut self,
        tool: &str,
        input: &serde_json::Value,
    ) -> Option<String> {
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
    pub(super) fn clear(&mut self, tool: &str, input: &serde_json::Value) {
        self.failures.remove(&Self::key(tool, input));
    }
}

/// How much of an unparseable argument payload to quote back to the model.
/// Head and tail both, because the head shows which call it was and the
/// tail shows where it stopped — and for a truncated call the tail is the
/// only part that identifies the cause.
pub(super) const MALFORMED_HEAD_CHARS: usize = 400;
pub(super) const MALFORMED_TAIL_CHARS: usize = 200;

/// The JSON type name to show a model that sent the wrong shape.
pub(super) fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a JSON string (double-encoded arguments)",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

/// Build the error for a tool call whose arguments never parsed.
///
/// The goal is a message a model can act on in one step. That needs three
/// things the old `{}` substitution destroyed: that the call did **not**
/// run, what Aurora actually received, and which of the two causes it was.
/// A payload that ends mid-token was cut off by the output cap and should
/// be re-issued smaller; anything else is a syntax error the model can fix
/// in place.
pub(super) fn malformed_input_error(tool: &str, raw: &str) -> ToolError {
    let char_count = raw.chars().count();
    let parse_error = serde_json::from_str::<serde_json::Value>(raw).err();
    let truncated = parse_error
        .as_ref()
        .is_some_and(|e| e.classify() == serde_json::error::Category::Eof);
    // Kept before `parse_error` is consumed below.
    let parse_error_position = parse_error
        .as_ref()
        .filter(|e| e.classify() == serde_json::error::Category::Syntax)
        .map(|e| (e.line(), e.column()));

    // When the text parses, name the JSON type that actually arrived. The old
    // wording — "parsed but were not a JSON object" — was a guess dressed as a
    // finding: it assumed the only way to reach this branch was a non-object,
    // and said so even for a well-formed object. A model reading that concluded
    // it had sent a string, "fixed" the shape it already had right, and
    // retracted a correct bug report. See lesson.md (2026-08-16).
    let detail = match parse_error {
        Some(error) => error.to_string(),
        None => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(_)) => "the arguments are a well-formed JSON object, so \
                                                 this rejection is an Aurora bug, not a problem \
                                                 with your call — report it rather than rewriting \
                                                 the arguments"
                .to_string(),
            Ok(other) => format!(
                "the arguments parsed as {}, but every tool takes a JSON object",
                json_type_name(&other)
            ),
            Err(error) => error.to_string(),
        },
    };

    let mut message = format!(
        "`{tool}` was NOT executed — its arguments did not parse as a JSON object.\n\
         Aurora received {char_count} characters; the parser reported: {detail}.\n\n"
    );

    if char_count <= MALFORMED_HEAD_CHARS + MALFORMED_TAIL_CHARS {
        message.push_str(&format!("Received verbatim:\n{raw}\n"));
        // Point at the character serde stopped on. "column 10" is a number the
        // model has to count out by hand against its own payload, and when it
        // miscounts it edits the wrong thing — which is how one missing pair of
        // quotes turned into five identical retries. A caret needs no counting.
        if let Some(caret) = caret_line(raw, parse_error_position.as_ref()) {
            message.push_str(&caret);
        }
        message.push('\n');
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
        // The list used to open with "an unescaped backslash or quote", which
        // was the wrong guess for the failure that actually happens most: a
        // value written without its quotes. Aurora now repairs that one before
        // this message is ever built, so anything reaching here is something
        // else — and the caret above already says where. Keep the advice to
        // what is still true and stop ranking causes.
        "Re-issue the call with valid JSON, changing only what the caret points at. Every value \
         that is not a number, `true`, `false` or `null` must be in double quotes, and a \
         backslash or a line break inside one must be written as `\\\\` or `\\n`."
    });

    ToolError::MalformedInput(message)
}

/// A `^` under the character the parser stopped on, aligned to the quoted
/// payload printed above it.
///
/// Returns `None` when the position cannot be aligned honestly: a payload
/// spanning several lines (the caret would sit under the wrong one, which is
/// worse than no caret), or a column outside the text.
fn caret_line(raw: &str, position: Option<&(usize, usize)>) -> Option<String> {
    let &(line, column) = position?;
    if line != 1 || column == 0 || raw.contains('\n') {
        return None;
    }
    let prefix: String = raw.chars().take(column - 1).collect();
    if prefix.chars().count() != column - 1 {
        return None;
    }
    // Tabs are copied through rather than counted as one column, so the caret
    // stays under its character in a terminal that renders them wide.
    let pad: String = prefix
        .chars()
        .map(|c| if c == '\t' { '\t' } else { ' ' })
        .collect();
    Some(format!("{pad}^ here (column {column})\n"))
}
