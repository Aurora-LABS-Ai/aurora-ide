//! Fold a stream of [`ThreadEvent`]s into a [`ProjectedThread`].
//!
//! The projection is the single source of truth for everything else in the
//! agent: the context engine builds API messages from `turns`, the chat panel
//! renders rich messages from the same projection, and the index command
//! pulls metadata (title, message count, preview) out of the projection.
//!
//! Folding rules:
//!
//! - `Session`        → seeds `created_at`, `updated_at`, schema version,
//!                       initial title.
//! - `TitleChanged`   → overwrites `title` (latest wins).
//! - `UserMessage`    → opens a new in-progress [`Turn`].
//! - `AssistantMessage` → appends a new [`ToolCallRound`] to the in-progress
//!                       turn (creating one if the LLM somehow responded
//!                       before any user message — defensive).
//! - `ToolResult`     → attaches the result to the matching tool call inside
//!                       the latest round.
//! - `Cancelled`      → synthesises an error [`ToolResult`] for any tool call
//!                       in `cancelled_tool_call_ids` that hasn't completed,
//!                       so the LLM API contract (`tool_calls` ↔ `tool`
//!                       responses) stays satisfied on the next request.
//! - `TurnFinalized`  → moves the in-progress turn into `turns`. Records
//!                       `outcome` and any token/context usage on the turn
//!                       for downstream UI display.
//! - `TurnSummary`    → attaches an LLM-generated summary to a finalized
//!                       turn (used by the message builder when the context
//!                       window is tight).
//! - `ModelChange`, `ThinkingLevelChange` → updated on `current_settings` so
//!                       the next request uses the right window size.
//! - `Unknown`        → ignored (forward compat).
//!
//! Folding never fails: malformed parent chains are repaired in place (an
//! orphan `ToolResult` without a matching tool call is dropped, an
//! `AssistantMessage` without a current turn opens a synthetic turn). This
//! keeps the agent functional even if a user manually edits a JSONL file.

use std::collections::{HashMap, HashSet};

use crate::context::types::{ToolCall, ToolCallRound, ToolResult, Turn, MAX_TOOL_RESULT_LENGTH};
use crate::db::{ContextUsage, TokenUsage};
use crate::threads::events::{CancelReason, EventToolCall, ThreadEvent};
#[cfg(test)]
use crate::threads::events::TurnOutcome;

/// Marker placed in `ToolResult::content` for results synthesised by the
/// projector when the user cancelled before the tool actually ran. Rendered
/// in the UI as a "Cancelled" badge; the LLM treats it as a normal tool
/// error and adapts its plan.
pub const CANCELLED_TOOL_RESULT_MARKER: &str = "[aurora:cancelled-by-user]";

/// Marker placed in `ToolResult::content` for tools that were never even
/// dispatched (e.g. the user stopped between the LLM emitting tool_calls
/// and Aurora picking up the first one).
pub const NEVER_DISPATCHED_TOOL_RESULT_MARKER: &str = "[aurora:cancelled-not-dispatched]";

// ============================================================================
// PROJECTION
// ============================================================================

/// Snapshot of a thread, derived purely from its event log.
#[derive(Debug, Clone)]
pub struct ProjectedThread {
    /// Thread id (matches the underlying file name).
    pub thread_id: String,
    /// Latest title ever applied. Defaults to `"New Chat"` if no title event
    /// has been observed yet.
    pub title: String,
    /// Finalized turns in chronological order.
    pub turns: Vec<Turn>,
    /// Turn currently being built (no `TurnFinalized` seen yet).
    pub current_turn: Option<Turn>,
    /// `id` of the last event that contributed to this projection. Used as
    /// the `parent_id` for the next appended event so the chain stays
    /// linkable.
    pub last_event_id: Option<String>,
    /// Created timestamp from the `Session` event.
    pub created_at: String,
    /// Most recent event timestamp.
    pub updated_at: String,
    /// Cumulative provider settings (latest wins).
    pub settings: ProjectedSettings,
    /// Token usage from the most recent `TurnFinalized`.
    pub token_usage: Option<TokenUsage>,
    /// Context usage from the most recent `TurnFinalized`.
    pub context_usage: Option<ContextUsage>,
}

/// Latest agent-level configuration learned from the event stream. Used by
/// the context engine to pick the right context window when building
/// requests, and by the UI to label which model produced which turn.
#[derive(Debug, Clone, Default)]
pub struct ProjectedSettings {
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub context_window: Option<u32>,
    pub max_output: Option<u32>,
    pub thinking_enabled: Option<bool>,
}

impl ProjectedThread {
    /// Empty projection seed. The thread id matches the file name, but no
    /// `Session` event has been folded yet — the caller usually replaces this
    /// with a real projection immediately.
    pub fn empty(thread_id: impl Into<String>) -> Self {
        let now = crate::threads::events::now_rfc3339_ms();
        Self {
            thread_id: thread_id.into(),
            title: "New Chat".to_string(),
            turns: Vec::new(),
            current_turn: None,
            last_event_id: None,
            created_at: now.clone(),
            updated_at: now,
            settings: ProjectedSettings::default(),
            token_usage: None,
            context_usage: None,
        }
    }

    /// `true` iff the thread has no finalized turns yet.
    pub fn is_empty(&self) -> bool {
        self.turns.is_empty() && self.current_turn.is_none()
    }

    /// Total finalized + pending turns.
    pub fn turn_count(&self) -> usize {
        self.turns.len() + self.current_turn.as_ref().map_or(0, |_| 1)
    }

    /// Short preview of the latest user message (for the index entry).
    pub fn preview(&self) -> String {
        let last = self
            .current_turn
            .as_ref()
            .or_else(|| self.turns.last());
        match last {
            Some(turn) => turn.user_message.chars().take(120).collect(),
            None => String::new(),
        }
    }
}

// ============================================================================
// PROJECTOR
// ============================================================================

/// Fold a sequence of events into a [`ProjectedThread`]. Pure function —
/// idempotent, deterministic, no I/O.
pub fn project(thread_id: &str, events: &[ThreadEvent]) -> ProjectedThread {
    let mut state = ProjectedThread::empty(thread_id);
    let mut turn_index: u32 = 0;

    for event in events {
        // Track last event id for parent chaining on the next append.
        let id = event.id();
        if !id.is_empty() {
            state.last_event_id = Some(id.to_string());
        }
        if let Some(ts) = event.timestamp() {
            state.updated_at = ts.to_string();
        }

        match event {
            ThreadEvent::Session {
                title, timestamp, ..
            } => {
                if let Some(t) = title {
                    state.title = t.clone();
                }
                state.created_at = timestamp.clone();
            }

            ThreadEvent::TitleChanged { title, .. } => {
                state.title = title.clone();
            }

            ThreadEvent::ModelChange {
                provider_id,
                model,
                context_window,
                max_output,
                ..
            } => {
                state.settings.provider_id = Some(provider_id.clone());
                state.settings.model = Some(model.clone());
                state.settings.context_window = Some(*context_window);
                state.settings.max_output = Some(*max_output);
            }

            ThreadEvent::ThinkingLevelChange {
                thinking_enabled, ..
            } => {
                state.settings.thinking_enabled = Some(*thinking_enabled);
            }

            ThreadEvent::UserMessage {
                id,
                content,
                timestamp,
                ide_context,
                ..
            } => {
                // Close any in-progress turn defensively. A well-formed log
                // emits TurnFinalized before the next user message, but we
                // never want to lose work if that event is missing.
                if let Some(prev) = state.current_turn.take() {
                    state.turns.push(prev);
                    turn_index = state.turns.len() as u32;
                }

                let mut turn = Turn::new(
                    state.thread_id.clone(),
                    content.clone(),
                    ide_context.clone(),
                    turn_index,
                );
                // Keep the persisted ids stable so reprojections produce the
                // same in-memory turn ids as the original run.
                turn.id = id.clone();
                turn.created_at = timestamp.clone();
                turn.updated_at = timestamp.clone();
                state.current_turn = Some(turn);
            }

            ThreadEvent::AssistantMessage {
                id,
                turn_id,
                content,
                thinking,
                tool_calls,
                timestamp,
                ..
            } => {
                let turn = ensure_current_turn(&mut state, turn_id, timestamp, &mut turn_index);
                let round_index = turn.rounds.len() as u32;
                let mut round = ToolCallRound::new(turn.id.clone(), content.clone(), round_index);
                round.id = id.clone();
                round.thinking = thinking.clone();
                round.created_at = timestamp.clone();
                for tc in tool_calls {
                    round.add_tool_call(tool_call_from_event(tc));
                }
                turn.rounds.push(round);
                turn.updated_at = timestamp.clone();
            }

            ThreadEvent::ToolResult {
                turn_id,
                tool_call_id,
                content,
                is_error,
                truncated,
                original_length,
                timestamp,
                ..
            } => {
                let Some(turn) = state
                    .current_turn
                    .as_mut()
                    .filter(|t| &t.id == turn_id)
                    .or_else(|| {
                        state
                            .turns
                            .iter_mut()
                            .rev()
                            .find(|t| &t.id == turn_id)
                    })
                else {
                    // Orphan result — drop. Keeps replay safe against manual
                    // edits / partial restores.
                    continue;
                };

                let Some(round) = turn
                    .rounds
                    .iter_mut()
                    .rev()
                    .find(|r| r.tool_calls.iter().any(|tc| tc.id == *tool_call_id))
                else {
                    continue;
                };

                let result = build_tool_result(
                    tool_call_id,
                    content,
                    *is_error,
                    *truncated,
                    *original_length,
                );
                round.add_tool_result(tool_call_id.clone(), result);
                turn.updated_at = timestamp.clone();
            }

            ThreadEvent::Cancelled {
                turn_id,
                cancelled_tool_call_ids,
                reason,
                timestamp,
                ..
            } => {
                synthesize_cancelled_results(
                    &mut state,
                    turn_id,
                    cancelled_tool_call_ids,
                    *reason,
                    timestamp,
                );
            }

            ThreadEvent::TurnFinalized {
                turn_id,
                outcome,
                token_usage,
                context_usage,
                timestamp,
                ..
            } => {
                if let Some(usage) = token_usage {
                    state.token_usage = Some(usage.clone());
                }
                if let Some(usage) = context_usage {
                    state.context_usage = Some(usage.clone());
                }
                if state.current_turn.as_ref().map(|t| &t.id) == Some(turn_id) {
                    let mut turn = state.current_turn.take().unwrap();
                    turn.updated_at = timestamp.clone();
                    // Outcome currently lives implicitly: if the last round's
                    // tool results contain the cancelled marker the UI shows
                    // it. We don't extend the Turn struct yet to keep this a
                    // strictly-additive change.
                    let _ = outcome; // explicitly handled by Cancelled events.
                    state.turns.push(turn);
                    turn_index = state.turns.len() as u32;
                }
            }

            ThreadEvent::TurnSummary {
                turn_id, summary, ..
            } => {
                if let Some(turn) = state.turns.iter_mut().find(|t| t.id == *turn_id) {
                    turn.summary = Some(summary.clone());
                }
            }

            ThreadEvent::Unknown => {}
        }
    }

    state
}

// ============================================================================
// HELPERS
// ============================================================================

/// Open a current turn if one isn't already pending. The fallback turn keeps
/// a malformed log (assistant before user) replayable instead of panicking.
fn ensure_current_turn<'a>(
    state: &'a mut ProjectedThread,
    turn_id: &str,
    timestamp: &str,
    turn_index: &mut u32,
) -> &'a mut Turn {
    let needs_new = state
        .current_turn
        .as_ref()
        .map(|t| t.id != turn_id)
        .unwrap_or(true);

    if needs_new {
        if let Some(prev) = state.current_turn.take() {
            state.turns.push(prev);
            *turn_index = state.turns.len() as u32;
        }
        let mut turn = Turn::new(state.thread_id.clone(), String::new(), None, *turn_index);
        turn.id = turn_id.to_string();
        turn.created_at = timestamp.to_string();
        turn.updated_at = timestamp.to_string();
        state.current_turn = Some(turn);
    }

    state
        .current_turn
        .as_mut()
        .expect("current_turn just set above")
}

fn tool_call_from_event(tc: &EventToolCall) -> ToolCall {
    ToolCall::new(tc.id.clone(), tc.name.clone(), tc.arguments.clone())
}

/// Convert an on-disk tool result payload into the in-memory representation,
/// re-applying truncation if the persisted content somehow grew past
/// [`MAX_TOOL_RESULT_LENGTH`].
fn build_tool_result(
    tool_call_id: &str,
    content: &str,
    is_error: bool,
    truncated: bool,
    original_length: Option<usize>,
) -> ToolResult {
    if is_error {
        return ToolResult::error(tool_call_id.to_string(), content.to_string());
    }
    if truncated {
        let original = original_length.unwrap_or(content.len());
        return ToolResult::truncated(tool_call_id.to_string(), content.to_string(), original);
    }
    if content.len() > MAX_TOOL_RESULT_LENGTH {
        let truncate_at = content
            .char_indices()
            .take_while(|(i, _)| *i < MAX_TOOL_RESULT_LENGTH)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let truncated_content = format!(
            "{}... [truncated, {} bytes total]",
            &content[..truncate_at],
            content.len()
        );
        return ToolResult::truncated(
            tool_call_id.to_string(),
            truncated_content,
            content.len(),
        );
    }
    ToolResult::success(tool_call_id.to_string(), content.to_string())
}

fn synthesize_cancelled_results(
    state: &mut ProjectedThread,
    turn_id: &str,
    cancelled_ids: &[String],
    reason: CancelReason,
    timestamp: &str,
) {
    let Some(turn) = state
        .current_turn
        .as_mut()
        .filter(|t| t.id == turn_id)
        .or_else(|| state.turns.iter_mut().rev().find(|t| t.id == turn_id))
    else {
        return;
    };

    // Build a set of ids that already have a result so we never overwrite a
    // real success or a real error.
    let mut already_resolved: HashSet<String> = HashSet::new();
    for round in &turn.rounds {
        for id in round.tool_results.keys() {
            already_resolved.insert(id.clone());
        }
    }

    let message = match reason {
        CancelReason::UserStop => format!(
            "{} User pressed Stop before this tool finished. \
             The previous step's result (if any) is unchanged. \
             Adapt your plan based on the user's next instruction.",
            CANCELLED_TOOL_RESULT_MARKER
        ),
        CancelReason::ProviderError => format!(
            "{} Provider returned an error before this tool finished. \
             Treat the partial work as inconclusive.",
            CANCELLED_TOOL_RESULT_MARKER
        ),
        CancelReason::ToolTimeout => format!(
            "{} Tool execution exceeded the configured timeout. \
             Result is unavailable.",
            CANCELLED_TOOL_RESULT_MARKER
        ),
        CancelReason::InternalError => format!(
            "{} Aurora hit an internal error while executing this tool. \
             The user has been notified; treat the call as failed.",
            CANCELLED_TOOL_RESULT_MARKER
        ),
    };

    // Map id → marker so we know whether the call was even dispatched.
    let mut id_to_marker: HashMap<&str, &str> = HashMap::new();
    for id in cancelled_ids {
        id_to_marker.insert(id, NEVER_DISPATCHED_TOOL_RESULT_MARKER);
    }

    for round in turn.rounds.iter_mut().rev() {
        let owned_ids: Vec<String> = round.tool_calls.iter().map(|tc| tc.id.clone()).collect();
        for tc_id in owned_ids {
            if already_resolved.contains(&tc_id) {
                continue;
            }
            if !id_to_marker.contains_key(tc_id.as_str()) {
                continue;
            }
            let marker = id_to_marker[tc_id.as_str()];
            let mut content = message.clone();
            // For "never dispatched" calls, prepend the secondary marker so
            // the UI can render a stronger status badge.
            if marker == NEVER_DISPATCHED_TOOL_RESULT_MARKER {
                content = format!("{NEVER_DISPATCHED_TOOL_RESULT_MARKER}\n{content}");
            }
            let result = ToolResult::error(tc_id.clone(), content);
            round.add_tool_result(tc_id.clone(), result);
            already_resolved.insert(tc_id);
        }
    }

    turn.updated_at = timestamp.to_string();
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::events::{new_event_id, now_rfc3339_ms, EventToolCall, ThreadEvent};

    fn ts() -> String {
        now_rfc3339_ms()
    }

    fn user(thread: &str, parent: &str, content: &str) -> ThreadEvent {
        ThreadEvent::user_message(thread, parent, content, None, None)
    }

    fn asst(
        thread: &str,
        parent: &str,
        turn_id: &str,
        content: &str,
        calls: Vec<EventToolCall>,
    ) -> ThreadEvent {
        ThreadEvent::AssistantMessage {
            id: new_event_id(),
            parent_id: parent.into(),
            thread_id: thread.into(),
            turn_id: turn_id.into(),
            timestamp: ts(),
            content: content.into(),
            thinking: None,
            tool_calls: calls,
        }
    }

    fn tool_result(
        thread: &str,
        parent: &str,
        turn_id: &str,
        call_id: &str,
        content: &str,
        is_error: bool,
    ) -> ThreadEvent {
        ThreadEvent::ToolResult {
            id: new_event_id(),
            parent_id: parent.into(),
            thread_id: thread.into(),
            turn_id: turn_id.into(),
            timestamp: ts(),
            tool_call_id: call_id.into(),
            tool_name: "tool".into(),
            content: content.into(),
            is_error,
            truncated: false,
            original_length: None,
            duration_ms: None,
        }
    }

    /// A clean turn (user → assistant w/ tools → results → finalized) projects
    /// one finalized turn with one round.
    #[test]
    fn happy_path_one_turn_one_round() {
        let session = ThreadEvent::session("t1", Some("My chat".into()));
        let user_ev = user("t1", session.id(), "do it");
        let calls = vec![EventToolCall {
            id: "c1".into(),
            name: "file_read".into(),
            arguments: r#"{"path":"/x"}"#.into(),
        }];
        let asst_ev = asst("t1", user_ev.id(), user_ev.id(), "ok", calls);
        let result_ev = tool_result(
            "t1",
            asst_ev.id(),
            user_ev.id(),
            "c1",
            "file contents",
            false,
        );
        let finalize = ThreadEvent::TurnFinalized {
            id: new_event_id(),
            parent_id: result_ev.id().into(),
            thread_id: "t1".into(),
            turn_id: user_ev.id().into(),
            timestamp: ts(),
            outcome: TurnOutcome::Completed,
            token_usage: None,
            context_usage: None,
        };

        let projection = project(
            "t1",
            &[session, user_ev.clone(), asst_ev, result_ev, finalize],
        );
        assert_eq!(projection.title, "My chat");
        assert_eq!(projection.turns.len(), 1);
        assert!(projection.current_turn.is_none());

        let turn = &projection.turns[0];
        assert_eq!(turn.id, user_ev.id());
        assert_eq!(turn.user_message, "do it");
        assert_eq!(turn.rounds.len(), 1);
        assert_eq!(turn.rounds[0].tool_calls.len(), 1);
        assert_eq!(turn.rounds[0].tool_results.len(), 1);
    }

    /// Cancellation preserves completed work AND fills synthetic results for
    /// the unfinished tool calls. The model sees a complete tool_calls ↔
    /// tool_result pairing on the next request.
    #[test]
    fn cancellation_synthesizes_missing_tool_results() {
        let session = ThreadEvent::session("t1", None);
        let user_ev = user("t1", session.id(), "edit three files");

        let calls = vec![
            EventToolCall {
                id: "c1".into(),
                name: "file_write".into(),
                arguments: "{}".into(),
            },
            EventToolCall {
                id: "c2".into(),
                name: "file_write".into(),
                arguments: "{}".into(),
            },
            EventToolCall {
                id: "c3".into(),
                name: "file_write".into(),
                arguments: "{}".into(),
            },
        ];
        let asst_ev = asst("t1", user_ev.id(), user_ev.id(), "starting edits", calls);

        // Only c1 finishes before the user clicks Stop.
        let r1 = tool_result("t1", asst_ev.id(), user_ev.id(), "c1", "wrote file 1", false);

        let cancel = ThreadEvent::Cancelled {
            id: new_event_id(),
            parent_id: r1.id().into(),
            thread_id: "t1".into(),
            turn_id: user_ev.id().into(),
            timestamp: ts(),
            completed_tool_call_ids: vec!["c1".into()],
            cancelled_tool_call_ids: vec!["c2".into(), "c3".into()],
            reason: CancelReason::UserStop,
        };
        let finalize = ThreadEvent::TurnFinalized {
            id: new_event_id(),
            parent_id: cancel.id().into(),
            thread_id: "t1".into(),
            turn_id: user_ev.id().into(),
            timestamp: ts(),
            outcome: TurnOutcome::Cancelled,
            token_usage: None,
            context_usage: None,
        };

        let projection = project(
            "t1",
            &[session, user_ev, asst_ev, r1, cancel, finalize],
        );
        assert_eq!(projection.turns.len(), 1);
        let turn = &projection.turns[0];
        let round = &turn.rounds[0];

        // All three calls now have results: one real, two synthetic.
        assert_eq!(round.tool_results.len(), 3);
        assert!(!round.tool_results["c1"].is_error);
        assert!(round.tool_results["c2"].is_error);
        assert!(round.tool_results["c3"].is_error);
        assert!(round.tool_results["c2"]
            .content
            .contains(CANCELLED_TOOL_RESULT_MARKER));
        assert!(round.tool_results["c2"]
            .content
            .contains(NEVER_DISPATCHED_TOOL_RESULT_MARKER));
    }

    /// `TitleChanged` events overwrite the title; latest wins.
    #[test]
    fn title_changed_event_overrides_session_title() {
        let session = ThreadEvent::session("t1", Some("Original".into()));
        let rename = ThreadEvent::TitleChanged {
            id: new_event_id(),
            parent_id: session.id().into(),
            thread_id: "t1".into(),
            timestamp: ts(),
            title: "Better title".into(),
        };
        let projection = project("t1", &[session, rename]);
        assert_eq!(projection.title, "Better title");
    }

    /// `TurnSummary` attaches to the matching finalized turn.
    #[test]
    fn turn_summary_attaches_to_finalized_turn() {
        let session = ThreadEvent::session("t1", None);
        let user_ev = user("t1", session.id(), "hi");
        let asst_ev = asst("t1", user_ev.id(), user_ev.id(), "hello", vec![]);
        let finalize = ThreadEvent::TurnFinalized {
            id: new_event_id(),
            parent_id: asst_ev.id().into(),
            thread_id: "t1".into(),
            turn_id: user_ev.id().into(),
            timestamp: ts(),
            outcome: TurnOutcome::Completed,
            token_usage: None,
            context_usage: None,
        };
        let summary = ThreadEvent::TurnSummary {
            id: new_event_id(),
            parent_id: finalize.id().into(),
            thread_id: "t1".into(),
            turn_id: user_ev.id().into(),
            timestamp: ts(),
            summary: "User said hi, assistant said hello".into(),
            original_token_count: Some(20),
            summary_token_count: Some(8),
        };

        let projection = project("t1", &[session, user_ev, asst_ev, finalize, summary]);
        assert_eq!(projection.turns.len(), 1);
        assert_eq!(
            projection.turns[0].summary.as_deref(),
            Some("User said hi, assistant said hello")
        );
    }

    /// Without a `TurnFinalized`, the turn stays in `current_turn` so the
    /// next replay can finalise it.
    #[test]
    fn unfinalized_turn_stays_current() {
        let session = ThreadEvent::session("t1", None);
        let user_ev = user("t1", session.id(), "hi");
        let projection = project("t1", &[session, user_ev]);
        assert!(projection.turns.is_empty());
        assert!(projection.current_turn.is_some());
        assert_eq!(projection.current_turn.unwrap().user_message, "hi");
    }

    /// `last_event_id` always points at the latest event so the next append
    /// can chain its `parent_id`.
    #[test]
    fn last_event_id_tracks_the_chain_head() {
        let session = ThreadEvent::session("t1", None);
        let user_ev = user("t1", session.id(), "hi");
        let user_id = user_ev.id().to_string();
        let projection = project("t1", &[session, user_ev]);
        assert_eq!(projection.last_event_id.as_deref(), Some(user_id.as_str()));
    }
}
