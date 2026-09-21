//! Per-CONVERSATION aggregation for the agent window's session-details tab.
//!
//! The sibling of [`project_stats`](super::project_stats), one level down: that
//! one answers "what has happened in this project" by scanning every session in
//! a folder, this one answers "what happened in this conversation" by reading
//! exactly one.
//!
//! Nothing new is persisted. Every number here already exists in the thread's
//! JSONL — timestamps, `usage`, and the content blocks the runtime writes.
//!
//! ## What this does that `project_stats` does not: tool OUTCOMES
//!
//! `project_stats` counts tool calls by name and stops there. It never learns
//! whether a call worked, because that answer is not in the `ToolUse` block —
//! it is in the `ToolResult` that comes back later, carrying `is_error` and a
//! `tool_use_id` pointing at the call. Pairing those two is the whole reason
//! this module exists: "6 failed" is a number you can act on, and "218 calls"
//! is not.
//!
//! ## Unresolved calls are their own bucket
//!
//! A call whose result never arrived — the turn was cancelled, the process
//! died, the provider dropped the stream — is neither a success nor a failure,
//! and folding it into either would be a lie in the direction of whichever we
//! picked. `calls == succeeded + failed + unresolved` always holds, so the UI
//! can show the gap instead of hiding it.
//!
//! ## Turn timing
//!
//! Same rule as `project_stats`, and for the same reason: a turn starts at a
//! user message and ends at the last message before the next one, so the totals
//! are time the agent was WORKING rather than wall-clock since you first said
//! hello. A turn still open at the end of the file (the live one) is closed at
//! its last message.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent_runtime::types::{ContentBlock, MessageRole};
use crate::commands::agent_v2::AgentRegistry;

/// How much of the prompt identifies a turn in the timeline's tooltip.
const PROMPT_PREVIEW_CHARS: usize = 100;

/// One bar in the turn timeline, and everything its tooltip shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStat {
    /// 1-based, as counted in this conversation.
    pub index: u32,
    pub started_at: i64,
    pub duration_ms: i64,
    /// What was asked, truncated — the timeline's only label.
    pub prompt: String,
    pub tool_calls: u32,
    pub failed_calls: u32,
    /// Reasoning time inside this turn, when the provider reported it.
    pub thinking_ms: i64,
    /// A compaction boundary landed in this turn.
    pub compacted: bool,

    // ── Tokens, per turn ────────────────────────────────────────────────
    /// Fresh prompt tokens the provider billed, cache writes excluded.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Model calls inside this turn. A turn with tools makes several.
    pub requests: u32,
    /// The largest prompt the model was handed during this turn —
    /// `input + cache_read + cache_write` of its biggest request.
    ///
    /// This is the number that answers "how full was the context here", and it
    /// is why the timeline can show context GROWING across a conversation and
    /// dropping at a compaction. Summing the turn's requests instead would
    /// double-count the prefix every request re-sends.
    pub context_tokens: u64,
    /// Provider-reported cost for this turn, when the provider reports one.
    pub cost_usd: Option<f64>,
    /// Some counts in this turn are Aurora's own estimate, not provider usage.
    pub estimated: bool,
    /// The model that answered. Recorded per turn because a conversation can
    /// switch model part-way and the totals would otherwise hide it.
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub name: String,
    pub calls: u32,
    pub succeeded: u32,
    pub failed: u32,
    /// Calls whose result never arrived.
    pub unresolved: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelUse {
    pub name: String,
    pub requests: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Summed provider-reported cost for this model in this conversation.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStats {
    pub thread_id: String,
    pub title: String,
    pub workspace_root: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,

    pub messages: u64,
    pub turns: u32,
    /// Summed turn durations — time the agent was working.
    pub active_ms: i64,
    /// First to last message, idle time included.
    pub span_ms: i64,
    pub longest_turn_ms: i64,
    pub thinking_ms: i64,
    pub compactions: u32,

    pub tool_calls: u32,
    pub tool_succeeded: u32,
    pub tool_failed: u32,
    pub tool_unresolved: u32,
    /// Busiest first, so the table leads with what the turn actually did.
    pub tools: Vec<ToolOutcome>,

    // ── Tokens, whole conversation ──────────────────────────────────────
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// `input + output` — billed throughput, cache excluded, matching
    /// `TokenUsage::total()` so this figure means the same thing everywhere.
    pub total_tokens: u64,
    pub requests: u32,
    /// Requests whose counts are Aurora's tiktoken estimate rather than
    /// provider usage. Anything derived from these is approximate, and the UI
    /// has to say so — see `TokenUsage::estimated`.
    pub estimated_requests: u32,
    /// Summed provider-reported cost. `None` when NO request reported one, so
    /// the UI can stay silent instead of rendering a confident `$0.00` for a
    /// provider that simply does not report money.
    pub cost_usd: Option<f64>,
    /// Requests that carried a cost, so the UI can say "partial" when a
    /// conversation mixed a reporting provider with a silent one.
    pub cost_reported_requests: u32,
    pub models: Vec<ConversationModelUse>,

    // ── Context ─────────────────────────────────────────────────────────
    /// The largest prompt the model was ever handed in this conversation.
    pub peak_context_tokens: u64,
    /// The window the thread last measured against, from its metadata sidecar.
    /// Zero when nothing has been measured yet.
    pub context_window: u32,
    /// Where the context stood at the last turn, as the sidecar recorded it.
    pub last_context_tokens: u32,
    pub last_context_percent: f64,

    /// Oldest first — the timeline reads left to right.
    pub turn_stats: Vec<TurnStat>,
}

/// First readable text in a message, trimmed to a preview.
fn prompt_preview(blocks: &[ContentBlock]) -> String {
    let text = blocks
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= PROMPT_PREVIEW_CHARS {
        return cleaned;
    }
    // Truncate on a CHAR boundary — a byte slice through a multi-byte character
    // panics, and titles are routinely not ASCII.
    let mut out: String = cleaned.chars().take(PROMPT_PREVIEW_CHARS).collect();
    out.push('…');
    out
}

/// An open turn while walking the file.
#[derive(Default)]
struct OpenTurn {
    index: u32,
    started_at: i64,
    last_ts: i64,
    prompt: String,
    tool_calls: u32,
    failed_calls: u32,
    thinking_ms: i64,
    compacted: bool,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    requests: u32,
    /// Running max, not a sum — see `TurnStat::context_tokens`.
    context_tokens: u64,
    cost_usd: Option<f64>,
    estimated: bool,
    model: Option<String>,
}

/// Per-model running totals while walking.
#[derive(Default)]
struct ModelTally {
    requests: u32,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cost_usd: Option<f64>,
}

#[tauri::command]
pub async fn conversation_stats_get(
    registry: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
) -> Result<ConversationStats, String> {
    if thread_id.trim().is_empty() {
        return Err("No conversation selected.".to_string());
    }
    let registry = registry.inner().clone();
    // One file, but it is deserialized line by line and a long thread is large.
    // Off the UI thread, like every other command that touches the session
    // store (see `commands/command_thread_safety.rs`).
    tauri::async_runtime::spawn_blocking(move || {
        let store = registry
            .require_store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?;
        compute(&store, thread_id)
    })
    .await
    .map_err(|e| format!("Conversation stats task failed: {e}"))?
}

fn compute(
    store: &crate::agent_runtime::session_store::SessionStore,
    thread_id: String,
) -> Result<ConversationStats, String> {
    let loaded = store
        .load(&thread_id)
        .map_err(|e| format!("Failed to read that conversation: {e}"))?
        .ok_or_else(|| "That conversation no longer exists.".to_string())?;
    Ok(aggregate(
        loaded.session.messages(),
        &loaded.metadata,
        thread_id,
    ))
}

/// The walk itself, over messages rather than a store.
///
/// Split out so the part with the actual logic in it — pairing tool calls to
/// their results, attributing a failure to the turn that MADE the call, and
/// taking context as a max rather than a sum — can be tested from a handful of
/// hand-built messages instead of needing a session file on disk.
fn aggregate(
    all_messages: &[crate::agent_runtime::types::ConversationMessage],
    metadata: &crate::agent_runtime::session_store::SessionMetadata,
    thread_id: String,
) -> ConversationStats {
    let mut messages = 0u64;
    let mut turns = 0u32;
    let mut active_ms = 0i64;
    let mut longest_turn_ms = 0i64;
    let mut thinking_ms = 0i64;
    let mut compactions = 0u32;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut cache_write_tokens = 0u64;
    let mut requests = 0u32;
    let mut estimated_requests = 0u32;
    let mut cost_usd: Option<f64> = None;
    let mut cost_reported_requests = 0u32;
    let mut peak_context_tokens = 0u64;
    let mut models: HashMap<String, ModelTally> = HashMap::new();
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;

    // tool_use_id → tool name, so a result can be attributed to the call it
    // answers. Results can arrive in a later message than the call, which is
    // why this is a map over the whole file rather than a per-message pairing.
    let mut call_names: HashMap<String, String> = HashMap::new();
    // tool_use_id → the turn it belongs to, so a failure lands on the right bar
    // even when the result comes back in the next message.
    let mut call_turn: HashMap<String, usize> = HashMap::new();
    let mut resolved: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tools: HashMap<String, ToolOutcome> = HashMap::new();

    let mut turn_stats: Vec<TurnStat> = Vec::new();
    let mut open: Option<OpenTurn> = None;

    for message in all_messages {
        messages += 1;
        if message.timestamp > 0 {
            first_ts = Some(first_ts.map_or(message.timestamp, |t| t.min(message.timestamp)));
            last_ts = Some(last_ts.map_or(message.timestamp, |t| t.max(message.timestamp)));
        }

        if message.role == MessageRole::User {
            // Close the previous turn before opening this one.
            if let Some(turn) = open.take() {
                push_turn(turn, &mut turn_stats, &mut active_ms, &mut longest_turn_ms);
            }
            if message.timestamp > 0 {
                turns += 1;
                open = Some(OpenTurn {
                    index: turns,
                    started_at: message.timestamp,
                    last_ts: message.timestamp,
                    prompt: prompt_preview(&message.blocks),
                    ..OpenTurn::default()
                });
            }
        } else if let Some(turn) = open.as_mut() {
            if message.timestamp > turn.last_ts {
                turn.last_ts = message.timestamp;
            }
        }

        // The index of the turn currently open, for attributing tool calls.
        let turn_slot = turn_stats.len();

        for block in &message.blocks {
            match block {
                ContentBlock::ToolUse { id, name, .. } => {
                    if name.is_empty() {
                        continue;
                    }
                    let entry = tools.entry(name.clone()).or_insert_with(|| ToolOutcome {
                        name: name.clone(),
                        calls: 0,
                        succeeded: 0,
                        failed: 0,
                        unresolved: 0,
                    });
                    entry.calls += 1;
                    call_names.insert(id.clone(), name.clone());
                    call_turn.insert(id.clone(), turn_slot);
                    if let Some(turn) = open.as_mut() {
                        turn.tool_calls += 1;
                    }
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    is_error,
                    ..
                } => {
                    let Some(name) = call_names.get(tool_use_id) else {
                        // A result with no matching call — a session written by
                        // an older build, or a truncated file. Counting it
                        // against an arbitrary tool would be worse than
                        // ignoring it.
                        continue;
                    };
                    // Guard against a result being recorded twice: the history
                    // copy and the rich sidecar can both carry one.
                    if !resolved.insert(tool_use_id.clone()) {
                        continue;
                    }
                    let failed = is_error.unwrap_or(false);
                    if let Some(entry) = tools.get_mut(name) {
                        if failed {
                            entry.failed += 1;
                        } else {
                            entry.succeeded += 1;
                        }
                    }
                    if failed {
                        // Attribute to the turn that MADE the call, which is not
                        // necessarily the turn we are in now.
                        if let Some(slot) = call_turn.get(tool_use_id).copied() {
                            if let Some(stat) = turn_stats.get_mut(slot) {
                                stat.failed_calls += 1;
                            } else if let Some(turn) = open.as_mut() {
                                turn.failed_calls += 1;
                            }
                        }
                    }
                }
                ContentBlock::Thinking { duration_ms, .. } => {
                    let ms = duration_ms.unwrap_or(0) as i64;
                    thinking_ms += ms;
                    if let Some(turn) = open.as_mut() {
                        turn.thinking_ms += ms;
                    }
                }
                ContentBlock::Compaction { .. } => {
                    compactions += 1;
                    if let Some(turn) = open.as_mut() {
                        turn.compacted = true;
                    }
                }
                _ => {}
            }
        }

        if let Some(usage) = &message.usage {
            // Cache WRITES are kept separate rather than folded into input the
            // way `project_stats` does. They are billed differently, and the
            // split is the only way to tell a turn that rebuilt the cache from
            // one that cheaply re-read it — a distinction the compaction work
            // showed matters (see `.knowledge/knowledge.md`).
            let input = u64::from(usage.input_tokens);
            let output = u64::from(usage.output_tokens);
            let read = u64::from(usage.cache_read_input_tokens.unwrap_or(0));
            let write = u64::from(usage.cache_creation_input_tokens.unwrap_or(0));

            input_tokens += input;
            output_tokens += output;
            cache_read_tokens += read;
            cache_write_tokens += write;
            requests += 1;
            if usage.estimated.unwrap_or(false) {
                estimated_requests += 1;
            }
            if let Some(cost) = usage.cost_usd {
                cost_usd = Some(cost_usd.unwrap_or(0.0) + cost);
                cost_reported_requests += 1;
            }

            // What the model was actually handed for THIS request.
            let context = input + read + write;
            if context > peak_context_tokens {
                peak_context_tokens = context;
            }

            if let Some(model) = message.model.as_deref() {
                let tally = models.entry(model.to_string()).or_default();
                tally.requests += 1;
                tally.input_tokens += input;
                tally.output_tokens += output;
                tally.cache_read_tokens += read;
                tally.cache_write_tokens += write;
                if let Some(cost) = usage.cost_usd {
                    tally.cost_usd = Some(tally.cost_usd.unwrap_or(0.0) + cost);
                }
            }

            if let Some(turn) = open.as_mut() {
                turn.input_tokens += input;
                turn.output_tokens += output;
                turn.cache_read_tokens += read;
                turn.cache_write_tokens += write;
                turn.requests += 1;
                if context > turn.context_tokens {
                    turn.context_tokens = context;
                }
                if let Some(cost) = usage.cost_usd {
                    turn.cost_usd = Some(turn.cost_usd.unwrap_or(0.0) + cost);
                }
                if usage.estimated.unwrap_or(false) {
                    turn.estimated = true;
                }
                // Last model wins within a turn: a turn that fell back to a
                // second model was ANSWERED by that one.
                if let Some(model) = message.model.as_deref() {
                    turn.model = Some(model.to_string());
                }
            }
        }
    }

    if let Some(turn) = open.take() {
        push_turn(turn, &mut turn_stats, &mut active_ms, &mut longest_turn_ms);
    }

    // Whatever never came back. Computed at the end rather than tracked live,
    // because a call is only unresolved once the file is exhausted.
    for (id, name) in &call_names {
        if resolved.contains(id) {
            continue;
        }
        if let Some(entry) = tools.get_mut(name) {
            entry.unresolved += 1;
        }
    }

    let mut tool_list: Vec<ToolOutcome> = tools.into_values().collect();
    tool_list.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));

    let mut model_list: Vec<ConversationModelUse> = models
        .into_iter()
        .map(|(name, t)| ConversationModelUse {
            name,
            requests: t.requests,
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            cache_read_tokens: t.cache_read_tokens,
            cache_write_tokens: t.cache_write_tokens,
            cost_usd: t.cost_usd,
        })
        .collect();
    model_list.sort_by(|a, b| b.requests.cmp(&a.requests).then_with(|| a.name.cmp(&b.name)));

    let tool_calls = tool_list.iter().map(|t| t.calls).sum();
    let tool_succeeded = tool_list.iter().map(|t| t.succeeded).sum();
    let tool_failed = tool_list.iter().map(|t| t.failed).sum();
    let tool_unresolved = tool_list.iter().map(|t| t.unresolved).sum();

    ConversationStats {
        thread_id,
        title: metadata.title.clone(),
        workspace_root: metadata.workspace_root.clone(),
        created_at: first_ts,
        updated_at: last_ts,
        messages,
        turns,
        active_ms,
        span_ms: match (first_ts, last_ts) {
            (Some(a), Some(b)) if b > a => b - a,
            _ => 0,
        },
        longest_turn_ms,
        thinking_ms,
        compactions,
        tool_calls,
        tool_succeeded,
        tool_failed,
        tool_unresolved,
        tools: tool_list,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens: input_tokens + output_tokens,
        requests,
        estimated_requests,
        cost_usd,
        cost_reported_requests,
        models: model_list,
        peak_context_tokens,
        context_window: metadata
            .context_usage
            .as_ref()
            .map_or(0, |c| c.context_window),
        last_context_tokens: metadata
            .context_usage
            .as_ref()
            .map_or(0, |c| c.used_tokens),
        last_context_percent: metadata
            .context_usage
            .as_ref()
            .map_or(0.0, |c| c.percentage),
        turn_stats,
    }
}

fn push_turn(
    turn: OpenTurn,
    out: &mut Vec<TurnStat>,
    active_ms: &mut i64,
    longest: &mut i64,
) {
    let duration = (turn.last_ts - turn.started_at).max(0);
    *active_ms += duration;
    if duration > *longest {
        *longest = duration;
    }
    out.push(TurnStat {
        index: turn.index,
        started_at: turn.started_at,
        duration_ms: duration,
        prompt: turn.prompt,
        tool_calls: turn.tool_calls,
        failed_calls: turn.failed_calls,
        thinking_ms: turn.thinking_ms,
        compacted: turn.compacted,
        input_tokens: turn.input_tokens,
        output_tokens: turn.output_tokens,
        cache_read_tokens: turn.cache_read_tokens,
        cache_write_tokens: turn.cache_write_tokens,
        requests: turn.requests,
        context_tokens: turn.context_tokens,
        cost_usd: turn.cost_usd,
        estimated: turn.estimated,
        model: turn.model,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::session_store::SessionMetadata;
    use crate::agent_runtime::types::{ConversationMessage, TokenUsage};

    fn meta() -> SessionMetadata {
        SessionMetadata {
            thread_id: "t1".into(),
            title: "Test".into(),
            workspace_root: Some("E:/proj".into()),
            model: None,
            token_usage: None,
            context_usage: None,
            pinned: false,
            archived_at: None,
            deep_research: false,
            created_at: "2026-09-17T00:00:00Z".into(),
            updated_at: "2026-09-17T00:00:00Z".into(),
        }
    }

    fn msg(role: MessageRole, ts: i64, blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage {
            event_id: None,
            role,
            blocks,
            usage: None,
            timestamp: ts,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
            aurora_context: None,
        }
    }

    fn call(id: &str, name: &str) -> ContentBlock {
        ContentBlock::ToolUse {
            id: id.into(),
            name: name.into(),
            input: serde_json::json!({}),
        }
    }

    fn result(id: &str, failed: bool) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: "ok".into(),
            is_error: if failed { Some(true) } else { None },
        }
    }

    /// The whole reason this module exists. `project_stats` counts calls and
    /// stops; the outcome lives in a DIFFERENT block that arrives later.
    #[test]
    fn pairs_tool_results_back_to_the_call_they_answer() {
        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "go".into() }]),
            msg(MessageRole::Assistant, 1_100, vec![call("a", "file_edit"), call("b", "grep")]),
            msg(MessageRole::Tool, 1_200, vec![result("a", true), result("b", false)]),
        ];
        let s = aggregate(&msgs, &meta(), "t1".into());

        assert_eq!(s.tool_calls, 2);
        assert_eq!(s.tool_failed, 1);
        assert_eq!(s.tool_succeeded, 1);
        let edit = s.tools.iter().find(|t| t.name == "file_edit").unwrap();
        assert_eq!((edit.calls, edit.failed, edit.succeeded), (1, 1, 0));
    }

    /// A call with no result is neither a success nor a failure. Folding it
    /// into either would be a lie in whichever direction we picked.
    #[test]
    fn a_call_that_never_came_back_is_unresolved_not_failed() {
        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "go".into() }]),
            msg(MessageRole::Assistant, 1_100, vec![call("a", "shell_execute")]),
        ];
        let s = aggregate(&msgs, &meta(), "t1".into());

        assert_eq!(s.tool_calls, 1);
        assert_eq!(s.tool_failed, 0);
        assert_eq!(s.tool_succeeded, 0);
        assert_eq!(s.tool_unresolved, 1);
        // The invariant the UI relies on to show the gap honestly.
        assert_eq!(
            s.tool_calls,
            s.tool_succeeded + s.tool_failed + s.tool_unresolved
        );
    }

    /// A result can land in a LATER turn than its call — the failure belongs to
    /// the turn that made it, or the timeline marks the wrong bar red.
    #[test]
    fn a_late_result_marks_the_turn_that_made_the_call() {
        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "one".into() }]),
            msg(MessageRole::Assistant, 1_100, vec![call("a", "file_edit")]),
            // A new user turn opens before the result arrives.
            msg(MessageRole::User, 2_000, vec![ContentBlock::Text { text: "two".into() }]),
            msg(MessageRole::Tool, 2_100, vec![result("a", true)]),
        ];
        let s = aggregate(&msgs, &meta(), "t1".into());

        assert_eq!(s.turn_stats.len(), 2);
        assert_eq!(s.turn_stats[0].failed_calls, 1, "turn 1 made the call");
        assert_eq!(s.turn_stats[1].failed_calls, 0, "turn 2 only saw the result");
    }

    /// Every request in a turn re-sends the whole prefix, so summing them
    /// multiplies the conversation by its own length.
    #[test]
    fn context_is_the_largest_request_not_the_sum() {
        let usage = |input: u32, read: u32| {
            Some(TokenUsage {
                input_tokens: input,
                output_tokens: 10,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: Some(read),
                estimated: None,
                cost_usd: None,
            })
        };
        let mut a = msg(MessageRole::Assistant, 1_100, vec![]);
        a.usage = usage(1_000, 4_000);
        let mut b = msg(MessageRole::Assistant, 1_200, vec![]);
        b.usage = usage(1_000, 9_000);

        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "go".into() }]),
            a,
            b,
        ];
        let s = aggregate(&msgs, &meta(), "t1".into());

        // 10_000, not 15_000.
        assert_eq!(s.turn_stats[0].context_tokens, 10_000);
        assert_eq!(s.peak_context_tokens, 10_000);
        // Tokens themselves DO sum.
        assert_eq!(s.input_tokens, 2_000);
        assert_eq!(s.cache_read_tokens, 13_000);
        assert_eq!(s.total_tokens, 2_020);
    }

    /// No request reported money → no cost, rather than a confident `$0.00`
    /// for a provider that simply does not report it.
    #[test]
    fn cost_stays_absent_when_nothing_reported_one() {
        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "go".into() }]),
        ];
        assert!(aggregate(&msgs, &meta(), "t1".into()).cost_usd.is_none());
    }

    /// Active time is summed TURNS, so a conversation left open overnight does
    /// not report the night as work.
    #[test]
    fn active_time_counts_turns_not_wall_clock() {
        let day = 86_400_000;
        let msgs = vec![
            msg(MessageRole::User, 1_000, vec![ContentBlock::Text { text: "one".into() }]),
            msg(MessageRole::Assistant, 6_000, vec![]),
            msg(MessageRole::User, day, vec![ContentBlock::Text { text: "two".into() }]),
            msg(MessageRole::Assistant, day + 3_000, vec![]),
        ];
        let s = aggregate(&msgs, &meta(), "t1".into());

        assert_eq!(s.active_ms, 8_000);
        assert_eq!(s.span_ms, day + 3_000 - 1_000);
        assert_eq!(s.longest_turn_ms, 5_000);
    }
}
