//! Agent runtime — Context accounting and compaction — deciding when the conversation is
//! too big, and rewriting it smaller without losing what the turn needs.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

impl ConversationRuntime {
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
    /// `file_read`. Gated on the turn being allowed to read outside the
    /// project, because the session store sits outside it: without that the
    /// read is refused, and pointing the model at a path it cannot open is
    /// worse than staying quiet.
    pub(super) fn transcript_hint(&self, session: &Session) -> Option<String> {
        if !self.config.workspace_access.reads_outside() {
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
    pub(super) fn compacted_view(&self, session: &Session) -> Vec<ConversationMessage> {
        let hint = self.transcript_hint(session);
        apply_compaction(session.messages(), hint.as_deref())
    }

    /// Memoized: the catalogue is fixed for the runtime's lifetime, and this
    /// runs inside the tool loop. Re-serializing ~25 schemas to JSON and
    /// tokenizing tens of thousands of characters on every iteration is pure
    /// waste — the answer cannot change between them.
    pub(super) fn fixed_request_overhead_tokens(&self) -> u32 {
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
    pub(super) fn projected_request_tokens(&self, session: &Session) -> u32 {
        let view = self.compacted_view(session);
        let replay = self.config.reasoning_replay;
        // Measurements older than the newest compaction describe a request
        // that no longer exists. `apply_compaction` keeps the verbatim TAIL,
        // and those tail messages carry the usage of the requests that
        // measured them — taken while the whole dropped head was still being
        // sent. Anchoring on one reports the size of the conversation
        // compaction just got rid of, so the number barely moves after a
        // shrink and the trigger keeps firing on a context that is already
        // small. The marker's own timestamp is the cutoff: only a request
        // issued after it has seen the compacted shape.
        let compacted_at = last_compaction_timestamp(session.messages());

        // Take the LARGEST projection the recent measurements support, not
        // simply the newest one.
        //
        // Within one compaction epoch the request only ever grows — every turn
        // appends. So a measurement that comes back SMALLER than the one
        // before it is not the context shrinking, it is the provider counting
        // differently, and gateways that fan out across upstream accounts do
        // exactly that: the same bytes measured 12,802 tokens on one backend
        // and 14,161 on another, byte-for-byte identical request, split
        // cleanly by which one served it. Anchoring on whichever landed last
        // made the reading jump between those bands every few requests, which
        // is the card "never settling" — and on the low reading it also
        // under-reports how full the window is, which is the direction that
        // ends in a context-overflow rejection.
        //
        // The look-back is capped because the bands alternate over a handful
        // of requests, and an unbounded scan would re-estimate the whole
        // transcript on every turn.
        const MAX_ANCHOR_LOOKBACK: usize = 8;

        let mut tail_tokens: u32 = 0;
        let mut best: Option<u32> = None;
        let mut seen = 0usize;

        for message in view.iter().rev() {
            let eligible = message.usage.as_ref().filter(|usage| {
                // Our own synthetic usage is an estimate wearing a
                // measurement's clothes — anchoring on it would launder a
                // guess into "measured".
                usage.estimated != Some(true)
                    // Measurements older than the newest compaction describe a
                    // request that no longer exists. `apply_compaction` keeps
                    // the verbatim TAIL, and those tail messages carry the
                    // usage of the requests that measured them — taken while
                    // the whole dropped head was still being sent.
                    && !compacted_at.is_some_and(|at| message.timestamp <= at)
            });

            if let Some(usage) = eligible {
                let anchor = measured_context_tokens(usage);
                if anchor != 0 {
                    let projected = anchor.saturating_add(tail_tokens);
                    best = Some(best.map_or(projected, |b| b.max(projected)));
                    seen += 1;
                    if seen >= MAX_ANCHOR_LOOKBACK {
                        break;
                    }
                }
            }

            // `tail_tokens` is the estimated size of everything AFTER the
            // message the next iteration will look at.
            tail_tokens = tail_tokens.saturating_add(estimate_message_tokens(message, replay));
        }

        best.unwrap_or_else(|| self.estimate_view_tokens(&view))
    }

    /// Aurora's own from-scratch size for a view, overhead included.
    ///
    /// The fallback inside [`Self::projected_request_tokens`], and separately
    /// the only way to compare two views on ONE scale — which is what the
    /// compaction card needs and used to lack. It is a genuine estimate and
    /// runs consistently low against what providers actually bill, so it is
    /// never mixed with a measured figure by subtraction; see
    /// [`Self::compact_inner`].
    pub(super) fn estimate_view_tokens(&self, view: &[ConversationMessage]) -> u32 {
        view.iter()
            .map(|m| estimate_message_tokens(m, self.config.reasoning_replay))
            .fold(self.fixed_request_overhead_tokens(), u32::saturating_add)
    }

    /// Summarize older history into a persistent compaction marker when the
    /// projected request crosses the configured threshold. Best-effort: any
    /// disabled/too-short/failed case returns WITHOUT mutating the session,
    /// so the turn always proceeds (trim stays the last-resort net).
    /// See `DOCS/compaction-design.md`.
    pub(super) async fn maybe_compact(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
    ) -> bool {
        let Some(threshold) = self.config.compaction_threshold else {
            return false;
        };
        // The window the ENDPOINT has proven it serves, which is not always
        // the one it was configured with. A model advertised at 1,050,000 and
        // served by a gateway that refuses 355,296 put the trigger line at
        // 892,500 — unreachable — so compaction never fired and every long
        // conversation ran until the provider killed it. `effective_window`
        // returns the configured number until the endpoint says otherwise.
        let model_key = session.model.clone().unwrap_or_default();
        let Some(window) = crate::agent_runtime::context_limits::effective_window(
            &model_key,
            self.config.context_window,
        ) else {
            return false;
        };
        if threshold <= 0.0 || window == 0 {
            return false;
        }

        // Projected size of the request we're about to build (after any prior
        // compaction is applied). Compare against threshold% of the window.
        let projected = self.projected_request_tokens(session);
        let limit = (window as f32 * threshold) as u32;
        if projected < limit {
            return false;
        }

        // Fail closed. The trigger condition is unchanged after a failed
        // summary, so an automatic retry would resend the same full head and
        // charge for it again. Only an explicit `/compact` (or reload) may try
        // after this latch is armed.
        if session.auto_compaction_blocked {
            return false;
        }

        let outcome = self
            .compact_inner(session, turn_id, seq, event_sink, cancel_token, Some(limit))
            .await;
        match outcome {
            CompactionOutcome::Compacted { .. } => {
                session.auto_compaction_blocked = false;
            }
            CompactionOutcome::Failed { .. } => {
                session.auto_compaction_blocked = true;
                crate::logging::log_warn(
                    "agent_runtime.compaction",
                    &format!(
                        "automatic compaction is disabled for thread {} after one failed attempt; \
                         deterministic trim remains active and only an explicit /compact may retry",
                        session.thread_id,
                    ),
                );
            }
            // Nothing was attempted and nothing was spent — a transcript too
            // short to cut is not a failure, and counting it as one would use
            // up the budget meant for real ones.
            CompactionOutcome::NothingToDo => {}
        }
        !matches!(outcome, CompactionOutcome::NothingToDo)
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
        let outcome = self
            .compact_inner(session, turn_id, seq, event_sink, cancel_token, None)
            .await;
        match outcome {
            CompactionOutcome::Compacted { before, after } => {
                session.auto_compaction_blocked = false;
                Some((before, after))
            }
            CompactionOutcome::Failed { .. } => {
                session.auto_compaction_blocked = true;
                None
            }
            CompactionOutcome::NothingToDo => None,
        }
    }

    /// The compaction pass itself. Reports WHY it produced no marker, which
    /// [`Self::maybe_compact`]'s breaker needs: "the transcript was too short"
    /// cost nothing and must not count against the retry budget, while "the
    /// summarizer failed" cost a full-history request and must.
    pub(super) async fn compact_inner(
        &self,
        session: &mut Session,
        turn_id: &str,
        seq: &mut u64,
        event_sink: &mpsc::Sender<AgentEventEnvelope>,
        cancel_token: &CancellationToken,
        required_after_ceiling: Option<u32>,
    ) -> CompactionOutcome {
        // The window this endpoint has proven it serves, not the one it was
        // configured with — see `context_limits`.
        let model_key = session.model.clone().unwrap_or_default();
        let Some(window) = crate::agent_runtime::context_limits::effective_window(
            &model_key,
            self.config.context_window,
        ) else {
            return CompactionOutcome::NothingToDo;
        };
        if window == 0 {
            return CompactionOutcome::NothingToDo;
        }

        let projected = self.projected_request_tokens(session);
        // Aurora's own reading of the view being replaced, captured BEFORE the
        // marker goes in. Paired with the same reading of the view that
        // replaces it, this is what puts both card numbers on one scale.
        let before_estimate = self.estimate_view_tokens(&self.compacted_view(session));

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
        // Rendered exactly as the live requests render it — each user
        // message's saved context folded after its text — so the summarizer
        // reads the same bytes the model did and the shared prefix holds.
        let head_view = fold_message_context(&apply_compaction(&session.messages()[..cut], None));
        let model = session.model.clone();
        // The head context (the repo map) the live requests carry in their
        // first user message, from the same per-thread memo, so the
        // summarizer can reproduce the conversation's prefix byte for byte.
        // Without it the shared-cache request diverged at the very first
        // message and the entire head was re-billed as fresh input — measured
        // at a 6.9% cache-read rate on a 200k-token compaction whose premise
        // was ~100%.
        let repo_map =
            self.head_context_block(session.workspace_root.as_deref(), &session.thread_id);
        let summarized = self
            .summarize_head(
                &head_view,
                &model,
                repo_map.as_deref(),
                &session.thread_id,
                cancel_token,
            )
            .await;
        let (summary, summary_usage) = match summarized {
            Ok(result) => result,
            Err(failure) => {
                emit_compaction_failed(event_sink, turn_id, seq, projected, failure).await;
                return CompactionOutcome::Failed {
                    cancelled: failure == CompactionFailure::Cancelled,
                };
            }
        };

        // Carry the conventions across the cut, not just the narrative. The
        // summarizer is told to describe the WORK; nothing asks it to record how
        // the tools were being called, and measured across every compaction on
        // this machine nothing ever did. Appended to the summary rather than
        // added as a new block so it rides the compacted view, the JSONL and the
        // UI through paths that already exist.
        let summary = match tool_usage_recap(&session.messages()[..cut]) {
            Some(recap) => format!("{summary}\n\n{recap}"),
            None => summary,
        };

        let now = chrono::Utc::now().timestamp_millis();
        let marker = ConversationMessage {
            role: MessageRole::System,
            blocks: vec![ContentBlock::Compaction {
                summary,
                before_tokens: projected,
                // Patched the moment the marker is in place — the size of the
                // view that REPLACES this one cannot be measured until the
                // marker exists to define it.
                after_tokens: projected,
                created_at: now,
            }],
            // What the summarization request itself cost, attributed to the
            // model that ran it. Carried on the marker because that is the
            // only message this request produces — without it the charge
            // exists on the bill and nowhere in Aurora.
            usage: Some(summary_usage),
            timestamp: now,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
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
        // Validate a candidate before mutating memory or the journal. Failed
        // compaction is a no-op by contract: no marker, no fake success, no
        // stale measured projection.
        let mut candidate = session.messages.clone();
        candidate.insert(cut, marker);

        // After-size, on the SAME scale as before-size.
        //
        // The two used to be built different ways: `before` from the measured
        // anchor, `after` by adding up overhead + summary + tail from scratch.
        // Nothing tied them together, so nothing stopped `after` exceeding
        // `before` — measured on 2026-08-15, a card reading
        // "88,979 → 114,228": a shrink that grew.
        //
        // Aurora's estimator runs well below what providers actually bill, but
        // it is consistent WITHIN one conversation, so the honest conversion is
        // a ratio rather than a difference. Measure how far the estimator sits
        // under the measured baseline on the view being replaced, then apply
        // that same factor to its reading of the view replacing it. `after <
        // before` becomes structural: it holds exactly when the new view
        // estimates smaller than the old one, which is the only case where a
        // shrink actually happened.
        let candidate_hint = self.transcript_hint(session);
        let candidate_view = apply_compaction(&candidate, candidate_hint.as_deref());
        let after_estimate = self.estimate_view_tokens(&candidate_view);
        let after = if before_estimate > 0 {
            let scale = f64::from(projected) / f64::from(before_estimate);
            (f64::from(after_estimate) * scale) as u32
        } else {
            after_estimate
        };
        let valid_reduction = after < projected;
        let reaches_target = required_after_ceiling.is_none_or(|ceiling| after < ceiling);
        if !valid_reduction || !reaches_target {
            let failure = if !valid_reduction {
                CompactionFailure::NoReduction
            } else {
                CompactionFailure::TargetNotReached
            };
            crate::logging::log_warn(
                "agent_runtime.compaction",
                &format!(
                    "discarded compaction candidate for thread {}: projected {projected}, \
                     candidate {after}, required ceiling {:?}; session left unchanged",
                    session.thread_id, required_after_ceiling,
                ),
            );
            emit_compaction_failed(event_sink, turn_id, seq, projected, failure).await;
            return CompactionOutcome::Failed { cancelled: false };
        }

        if let Some(ContentBlock::Compaction { after_tokens, .. }) =
            candidate[cut].blocks.first_mut()
        {
            *after_tokens = after;
        }

        // Commit only after every invariant passes.
        session.messages = candidate;

        // The marker went in at `cut`, not at the end, which is an edit the
        // journal cannot express as one more line — so it has just gone silent
        // for the rest of this turn. Rewrite the file now to make it whole and
        // let appends resume, rather than leaving the remainder of a turn that
        // is often only half done in memory alone. Deliberately AFTER
        // `after_tokens` is patched, so the file matches what is in memory
        // instead of persisting the placeholder.
        //
        // Costs one full rewrite, on an event that happens a handful of times
        // in a long conversation and has just spent minutes in a model call.
        if let Err(error) = session.resync_journal() {
            crate::logging::log_warn(
                "agent_runtime.compaction",
                &format!(
                    "could not rewrite the session file for thread {} after compacting: {error} \
                     — the rest of this turn is not crash-recoverable; it still persists in full \
                     when the turn ends",
                    session.thread_id,
                ),
            );
        }

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
    pub(super) async fn summarize_head(
        &self,
        head_view: &[ConversationMessage],
        model: &Option<String>,
        repo_map: Option<&str>,
        session_key: &str,
        cancel_token: &CancellationToken,
    ) -> Result<(String, TokenUsage), CompactionFailure> {
        // Exactly one provider request per compaction. The conversation client
        // keeps its cache-compatible request shape; a pinned summarizer uses
        // the standalone shape. There is intentionally no automatic fallback:
        // the old fallback sent the entire head a second time at the fresh-input
        // rate whenever the first response was empty or tool-shaped.
        let share_cache = self.compaction_client.is_none();
        self.summarize_with(
            head_view,
            model,
            repo_map,
            session_key,
            cancel_token,
            share_cache,
        )
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
    pub(super) async fn summarize_with(
        &self,
        head_view: &[ConversationMessage],
        model: &Option<String>,
        repo_map: Option<&str>,
        session_key: &str,
        cancel_token: &CancellationToken,
        share_cache: bool,
    ) -> Result<(String, TokenUsage), CompactionFailure> {
        // A pinned compaction model brings its own client; otherwise the
        // summary rides the conversation's provider and model.
        let (client, model) = match &self.compaction_client {
            Some((client, model)) => (client.clone(), model.clone()),
            None => (self.api_client.clone(), model.clone().unwrap_or_default()),
        };
        if model.is_empty() {
            return Err(CompactionFailure::ProviderError);
        }

        // Reasoning is kept when sharing the cache — removing it would alter
        // the prefix and cost far more than it saves — and stripped otherwise,
        // where it is unusable weight. Sharing also reproduces the repo map
        // in the first user message: the live requests carry it there, so a
        // head without it diverges from the cached prefix at message one and
        // the whole exercise is pointless.
        let head = if share_cache {
            match repo_map {
                Some(map) => inject_repo_map(head_view, map),
                None => head_view.to_vec(),
            }
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
        // Which note to ask for. A research conversation and a coding one need
        // different things preserved, and the list IS the prompt.
        let summary_prompt = if self.config.execution_mode_is_chat {
            CHAT_COMPACTION_SYSTEM_PROMPT
        } else {
            COMPACTION_SYSTEM_PROMPT
        };
        let instruction = if share_cache {
            format!("{COMPACTION_NO_TOOLS_PREAMBLE}\n\n{summary_prompt}\n\n{COMPACTION_INSTRUCTION}")
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
            aurora_context: None,
            model: None,
        });

        let (tx, mut rx) = mpsc::channel::<AssistantEvent>(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

        let schemas = if share_cache {
            self.tools.schemas()
        } else {
            Vec::new()
        };
        let standalone_reasoning = ReasoningConfig::default();
        let reasoning = if share_cache {
            self.config.reasoning.as_request()
        } else {
            standalone_reasoning.as_request()
        };
        // When sharing the cache the system slot must be byte-identical to the
        // live requests', `<machine_tools>` included — see
        // `request_system_prompt`.
        let shared_system_prompt = if share_cache {
            self.request_system_prompt(session_key)
        } else {
            None
        };
        let request = ApiRequest {
            model: &model,
            system_prompt: if share_cache {
                shared_system_prompt.as_deref()
            } else {
                Some(summary_prompt)
            },
            messages: &messages,
            tools: &schemas,
            tool_choice: crate::agent_runtime::api_client::ToolChoice::None,
            // Temperature is not part of the cache key, so a low one is free
            // either way.
            temperature: Some(0.3),
            max_output_tokens: self.config.compaction_summary_budget,
            // Reasoning config IS part of the cache key. When sharing, it has
            // to match the conversation's or the prefix is invalidated.
            // Standalone summarization keeps it off.
            reasoning,
            // Summarizing never calls a tool, so there is nothing to keep a
            // stream open for.
            tool_bridge: None,
            // Same conversation, same affinity key — this request exists to
            // read the conversation's cache.
            session_key: Some(session_key),
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(COMPACTION_TIMEOUT_SECS),
            client.stream(request, tx, cancel_token.clone()),
        )
        .await;
        let _ = drain.await;

        match result {
            // Strip the `<analysis>` scratchpad here, at the boundary, so the
            // drafting pass costs output tokens once and never enters context.
            Ok(Ok(turn)) => {
                let summary =
                    format_compact_summary(&collect_assistant_text(&turn.assistant_message));
                if summary.trim().is_empty() {
                    Err(CompactionFailure::EmptySummary)
                } else {
                    Ok((summary, turn.usage))
                }
            }
            Ok(Err(ApiError::Cancelled)) => Err(CompactionFailure::Cancelled),
            Ok(Err(error)) => {
                crate::logging::log_warn(
                    "agent_runtime.compaction",
                    &format!("single compaction request failed: {error}"),
                );
                Err(CompactionFailure::ProviderError)
            }
            Err(_) => {
                crate::logging::log_warn(
                    "agent_runtime.compaction",
                    &format!(
                        "single compaction request exceeded the {} second hard limit",
                        COMPACTION_TIMEOUT_SECS,
                    ),
                );
                Err(CompactionFailure::Timeout)
            }
        }
    }
}

async fn emit_compaction_failed(
    event_sink: &mpsc::Sender<AgentEventEnvelope>,
    turn_id: &str,
    seq: &mut u64,
    before_tokens: u32,
    failure: CompactionFailure,
) {
    emit_native_tool_event(
        event_sink,
        turn_id,
        seq,
        AssistantEvent::CompactionFailed {
            before_tokens,
            reason: failure.code().to_string(),
            cancelled: failure == CompactionFailure::Cancelled,
        },
    )
    .await;
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
pub(super) const COMPACT_TAIL_MAX_TOKENS: u32 = 40_000;

/// Hard wall-clock ceiling for one compaction model request. Dropping the
/// future closes the stream; there is no fallback or retry after this point.
pub(super) const COMPACTION_TIMEOUT_SECS: u64 = 4 * 60;

/// Ceiling on the tail as a share of the window, for models where
/// [`COMPACT_TAIL_MAX_TOKENS`] would be most of the context (or more than all
/// of it). A 32k model gets an 8k tail; every model at 160k and up gets the
/// full 40k. This is the only place the window still has a say, and it can
/// only ever make the budget SMALLER.
pub(super) const COMPACT_TAIL_WINDOW_DIVISOR: u32 = 4;

/// The verbatim-tail budget for a given window: at most
/// [`COMPACT_TAIL_MAX_TOKENS`], and never more than a quarter of the window.
pub(super) fn compact_tail_budget(window: u32) -> u32 {
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
pub(super) const COMPACTION_SYSTEM_PROMPT: &str = r#"You are writing the memory of this conversation.

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

/// The same job for an Aurora Chat conversation.
///
/// Its own prompt rather than a tweak of the one above, because the LIST is the
/// prompt. The coding version asks for file paths, function signatures and code
/// snippets — a research conversation has none of those, and a summariser told
/// to preserve them will pad the note with the nearest thing it can find while
/// dropping what actually mattered.
///
/// What matters here is the opposite: the sources, what they said, what was
/// established, and what was checked and ruled out. A research note that loses
/// its citations has lost the research, because the answers stop being
/// verifiable the moment the transcript behind them is gone.
pub(super) const CHAT_COMPACTION_SYSTEM_PROMPT: &str = r#"You are writing the memory of this conversation.

Everything above is about to be removed and replaced by exactly what you write now. The conversation continues immediately afterward, with a user who saw no interruption and expects you to still know what you found. Anything you leave out is gone for good.

Write the note you would want to find.

First, in <analysis> tags, work through the conversation in order. For each part, identify:
- what the user actually wanted to know, in their words
- what you looked up, and what each source said
- what you concluded, and how confident you were
- anything you checked and RULED OUT — a dead end you forget is a dead end you will walk down again
- any point where the user corrected you, narrowed the question, or changed direction

Then, in <summary> tags, write the note itself under these headings:

1. The question — what the user is trying to find out, in detail and in their own framing.
2. What has been established — the findings, each with the source that supports it. A claim without its source is not a finding, it is a memory.
3. Sources — every page, paper or document you read that still matters. Title, URL, and what it was good for.
4. Ruled out — what you checked that did not pan out, and why. This is the section that stops the work repeating itself.
5. Disagreements — where sources conflicted, and which you found more credible.
6. Every user message — list all of the user's own messages, in order. Their exact words are the requirements; do not compress them into themes.
7. Standing instructions — preferences and constraints the user has stated that still apply.
8. Open questions — what is still unresolved, and what you were going to do about it.
9. What was presented — anything you built on the canvas, by title, and what it showed.
10. Next step — the single next action, only if it follows directly from the most recent request. If the question was answered, say so instead of inventing one.

Be specific. Exact figures, exact titles, exact URLs. A number you round or a source you describe instead of naming is one the user cannot check.

Respond with text only. Do not call tools. Do not address the user."#;

/// Placed FIRST in the trailing message on the cache-sharing path.
///
/// Keeping the tool catalogue is what preserves the cache key, but a model
/// handed tools will sometimes reach for one instead of answering — and this
/// request gets a single turn, so a tool call means no note at all. Stated up
/// front, and in terms of the consequence, because a warning buried under a
/// thousand words of instructions is a warning the model has already scrolled
/// past.
pub(super) const COMPACTION_NO_TOOLS_PREAMBLE: &str = "CRITICAL: answer with text only. Do NOT call any tool — not to read a file, not to check anything. You already have everything you need above, this is your only turn, and a tool call will waste it and lose the note entirely.";

/// Trailing user instruction appended to the head when requesting the summary.
pub(super) const COMPACTION_INSTRUCTION: &str =
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
pub(super) fn strip_reasoning(messages: Vec<ConversationMessage>) -> Vec<ConversationMessage> {
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
pub(super) fn format_compact_summary(raw: &str) -> String {
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
pub(super) fn compaction_preamble(summary: &str, transcript_hint: Option<&str>) -> String {
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
pub(super) fn apply_compaction(
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
                    aurora_context: None,
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
/// How many distinct tools the recap may carry.
const RECAP_MAX_TOOLS: usize = 12;
/// How much of one call's arguments to keep. Enough to show the SHAPE.
const RECAP_MAX_ARG_CHARS: usize = 240;

/// The last call of each tool that actually WORKED, taken from the messages a
/// compaction is about to delete.
///
/// Why this exists: a summary describes the task, not the conventions. Measured
/// across every compaction on this machine (17 of them, 571 threads), the word
/// `file_read` appears in **zero** summaries — while the head being replaced
/// held up to 258 tool calls. So the model resumes knowing what it was doing
/// and nothing about how it had been calling its tools.
///
/// That is not hypothetical. In thread `9db4f0f0` the marker lands at line 131
/// after 130 well-formed calls, and the first malformed `file_read` of the whole
/// thread arrives at line 135 — four messages later. Its own prior calls were
/// the working examples; the summary kept none of them.
///
/// Deliberately EXAMPLES, not prose. A rule the model reads is advice; its own
/// last successful call is evidence, and evidence is what it was already
/// copying. It also covers every tool automatically — MCP tools included, which
/// no hand-written instruction will ever reach.
///
/// Only successful calls qualify: replaying a rejected call would teach exactly
/// the shape that failed.
pub(super) fn tool_usage_recap(messages: &[ConversationMessage]) -> Option<String> {
    // tool_use_id → whether its result came back an error.
    let mut failed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for message in messages {
        for block in &message.blocks {
            if let ContentBlock::ToolResult {
                tool_use_id,
                is_error,
                ..
            } = block
            {
                if is_error.unwrap_or(false) {
                    failed.insert(tool_use_id.as_str());
                }
            }
        }
    }

    // Walk forward and keep overwriting, so what survives is the LAST good call
    // of each tool — the one closest to where work resumes.
    let mut latest: Vec<(String, String)> = Vec::new();
    for message in messages {
        for block in &message.blocks {
            let ContentBlock::ToolUse { id, name, input } = block else {
                continue;
            };
            if failed.contains(id.as_str()) {
                continue;
            }
            let mut args = input.to_string();
            if args.chars().count() > RECAP_MAX_ARG_CHARS {
                let cut: String = args.chars().take(RECAP_MAX_ARG_CHARS).collect();
                args = format!("{cut}…");
            }
            let line = format!("{name}({args})");
            match latest.iter_mut().find(|(tool, _)| tool == name) {
                Some(slot) => slot.1 = line,
                None => latest.push((name.clone(), line)),
            }
        }
    }

    if latest.is_empty() {
        return None;
    }
    // Most recently used tools first, then cap: the tail of a long turn is what
    // the next request continues from.
    latest.reverse();
    latest.truncate(RECAP_MAX_TOOLS);

    let body = latest
        .iter()
        .map(|(_, line)| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n");

    Some(format!(
        "<tool_usage_recap>\nThe last call of each tool that succeeded before this point. These are \
         YOUR OWN calls, replayed verbatim as a reminder of the argument shapes this conversation \
         was already using — copy them rather than re-deriving a form from the schema.\n\n{body}\n\
         </tool_usage_recap>"
    ))
}

/// Where to cut so the tail fits [`compact_tail_budget`].
///
/// A cut is legal at any index whose TAIL is self-contained: no `tool_result`
/// in it may answer a `tool_use` that the summary is about to replace. That is
/// the only real constraint the wire imposes, and it admits every complete
/// tool round, not just user messages.
///
/// This used to cut ONLY at a user message, and that was the binding limit on
/// the whole feature. Aurora's turns are long and autonomous: one instruction
/// routinely produces sixty-plus tool calls, so a thread has very few user
/// boundaries and all the growth sits after the last one. Measured on this
/// machine, thread `b3f19c05` compacted 501,776 → 195,974 tokens against a
/// 40,000-token tail budget, because the only boundary available left a tail of
/// ~190k. Two others reclaimed nothing at all; one came back 28% LARGER than
/// what it replaced.
///
/// `repair_tool_pairing` runs last on the API view and would drop an orphaned
/// result anyway, but being correct here is better than being repaired later:
/// a dropped result is a hole in the tail the model can see.
pub(super) fn compaction_cut(
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

    // Already inside the budget: there is nothing to reclaim, and summarizing
    // would spend a full-history request to make the conversation bigger.
    if suffix[0] <= target {
        return None;
    }

    // Earliest message each tool call was made in.
    let mut first_use: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for block in &message.blocks {
            if let ContentBlock::ToolUse { id, .. } = block {
                first_use.entry(id.as_str()).or_insert(index);
            }
        }
    }

    // `answers_from[i]` = the oldest call answered by any result at or after i.
    // A cut at `i` is legal exactly when that is not older than `i` — otherwise
    // the tail opens with a result whose call no longer exists.
    //
    // A result whose call is nowhere in the transcript is already broken and is
    // `repair_tool_pairing`'s business, so it must not veto an otherwise good
    // cut: `usize::MAX` lets it pass.
    let mut answers_from = vec![usize::MAX; messages.len() + 1];
    for i in (0..messages.len()).rev() {
        let mut oldest = answers_from[i + 1];
        for block in &messages[i].blocks {
            if let ContentBlock::ToolResult { tool_use_id, .. } = block {
                let used_at = first_use
                    .get(tool_use_id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX);
                oldest = oldest.min(used_at);
            }
        }
        answers_from[i] = oldest;
    }
    let legal = |i: usize| i > 0 && i < messages.len() && answers_from[i] >= i;

    // Oldest legal boundary whose tail fits — the one that reclaims the most.
    if let Some(idx) = (1..messages.len()).find(|&i| legal(i) && suffix[i] <= target) {
        return Some(idx);
    }
    // Nothing fits: keep the smallest legal tail rather than giving up, which is
    // what leaves a thread pinned over its window with no way down.
    (1..messages.len()).rev().find(|&i| legal(i))
}

/// Concatenate the visible text blocks of an assistant message (used to pull
/// the summary text out of the summarization call's reconstructed message).
pub(super) fn collect_assistant_text(message: &ConversationMessage) -> String {
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

/// Why a compaction pass produced (or did not produce) a marker.
///
/// The distinction the circuit breaker turns on: only [`Self::SummaryFailed`]
/// spent money.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionOutcome {
    /// A marker was inserted. `before`/`after` are the projected request sizes
    /// either side of it.
    Compacted { before: u32, after: u32 },
    /// The summarization request ran but no marker was committed. History is
    /// untouched. `cancelled` is surfaced separately in the UI.
    Failed { cancelled: bool },
    /// Compaction was disabled, or the transcript had no safe cut. No request
    /// was made.
    NothingToDo,
}

/// Terminal reasons for a compaction request that did not commit a marker.
/// Codes are stable wire values; provider error details stay in the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionFailure {
    Cancelled,
    EmptySummary,
    ProviderError,
    Timeout,
    NoReduction,
    TargetNotReached,
}

impl CompactionFailure {
    const fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::EmptySummary => "empty_summary",
            Self::ProviderError => "provider_error",
            Self::Timeout => "timeout",
            Self::NoReduction => "no_reduction",
            Self::TargetNotReached => "target_not_reached",
        }
    }
}

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
/// When the newest compaction marker was written, if there is one.
///
/// The boundary between "this measurement describes the conversation we are
/// about to send" and "this measurement describes the one we replaced".
pub(super) fn last_compaction_timestamp(messages: &[ConversationMessage]) -> Option<i64> {
    messages
        .iter()
        .rev()
        .find(|m| {
            m.blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Compaction { .. }))
        })
        .map(|m| m.timestamp)
}
