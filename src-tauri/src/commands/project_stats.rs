//! Per-project aggregation for the agent window's Project panel.
//!
//! A "project" is a workspace folder; every thread records the
//! `workspace_root` it ran in, so this scans the same session JSONL the
//! Profile page reads and filters to one folder.
//!
//! Nothing new is persisted. Every number here is derived from data the
//! runtime already writes: `ConversationMessage.timestamp`, `.usage`, tool-use
//! blocks, and `SessionMetadata`.
//!
//! ## Active time vs elapsed time
//!
//! A thread's elapsed span (`last - first`) counts the hours between asking
//! something and coming back after lunch — or, as the Profile page once
//! reported, the 1484 hours since you opened a chat you still reply to. It is
//! not time anything was working, so this module sums **per-turn** durations
//! instead: each user message starts a turn, and the turn ends at the last
//! message before the next one. The result is time the agent was actually
//! working, and it is always <= the elapsed span.
//!
//! [`UsageStats`](super::usage_stats::UsageStats) now measures its "longest
//! task" the same way, for the same reason.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Local, TimeZone};
use serde::Serialize;
use tauri::State;

use crate::agent_runtime::types::{ContentBlock, MessageRole};
use crate::commands::agent_v2::AgentRegistry;
use crate::commands::usage_stats::{
    DayUsage, ModelUsage, ProviderRequestUsage, RequestTally, ToolUsage,
};

/// Cap on the "slowest turns" list — enough to spot a pattern, short enough to
/// read at a glance.
const LONGEST_TURNS: usize = 5;
/// How much of the prompt identifies a turn in the slowest-turns list.
const PROMPT_PREVIEW_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConversation {
    pub thread_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: u64,
    /// User → assistant cycles.
    pub turns: u32,
    /// Summed turn durations — time the agent was working.
    pub active_ms: i64,
    /// First to last message — includes time the conversation sat idle.
    pub span_ms: i64,
    pub tokens: u64,
    pub model: Option<String>,
    pub archived: bool,
}

/// One notably slow turn, so "what took so long" is answerable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLongTurn {
    pub thread_id: String,
    pub thread_title: String,
    /// Opening of the user message that started the turn.
    pub prompt: String,
    pub started_at: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub workspace_root: String,
    pub total_conversations: u32,
    pub archived_conversations: u32,
    pub total_messages: u64,
    pub total_turns: u32,
    /// Summed working time across every conversation in the project.
    pub total_active_ms: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    /// Newest activity first.
    pub conversations: Vec<ProjectConversation>,
    pub top_models: Vec<ModelUsage>,
    pub top_tools: Vec<ToolUsage>,
    /// Every API request this project has sent, across all its conversations.
    /// One call per tool step, so far larger than `total_turns`.
    pub total_requests: u32,
    /// Those requests grouped by provider, models nested. Descending.
    pub requests_by_provider: Vec<ProviderRequestUsage>,
    pub longest_turns: Vec<ProjectLongTurn>,
    /// Ascending by date; days with no activity are absent.
    pub days: Vec<DayUsage>,
    pub first_activity: Option<String>,
    pub last_activity: Option<String>,
}

fn local_day(ts_ms: i64) -> Option<String> {
    if ts_ms <= 0 {
        return None;
    }
    Local
        .timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// Compare two workspace paths as the *same folder*.
///
/// Rust and the frontend can spell one folder differently (separators,
/// drive-letter case), and a thread's recorded root came from whichever wrote
/// it. Comparing raw strings silently produced empty projects.
fn same_workspace(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

/// First line of a user message, trimmed for display.
fn prompt_preview(blocks: &[ContentBlock]) -> String {
    let text = blocks
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("")
        .trim();
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() > PROMPT_PREVIEW_CHARS {
        let cut: String = line.chars().take(PROMPT_PREVIEW_CHARS).collect();
        format!("{}…", cut.trim_end())
    } else {
        line.to_string()
    }
}

/// Aggregate every conversation that ran in `workspace_root`.
#[tauri::command]
pub fn project_stats_get(
    registry: State<'_, Arc<AgentRegistry>>,
    workspace_root: String,
) -> Result<ProjectStats, String> {
    if workspace_root.trim().is_empty() {
        return Err("No project selected.".to_string());
    }
    let store = registry.store().clone();
    let summaries = store
        .list_summaries()
        .map_err(|e| format!("Failed to list conversations: {e}"))?;

    let mut days: HashMap<String, DayUsage> = HashMap::new();
    let mut tools: HashMap<String, u32> = HashMap::new();
    // Same tally the Profile page uses, so "requests" means one thing across
    // the product rather than two implementations that drift apart.
    let mut requests = RequestTally::default();
    let mut models: HashMap<String, (u32, u64)> = HashMap::new();
    let mut conversations: Vec<ProjectConversation> = Vec::new();
    let mut longest_turns: Vec<ProjectLongTurn> = Vec::new();

    let mut total_messages = 0u64;
    let mut total_turns = 0u32;
    let mut total_active_ms = 0i64;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut archived_conversations = 0u32;
    let mut first_activity: Option<i64> = None;
    let mut last_activity: Option<i64> = None;

    for summary in &summaries {
        let loaded = match store.load(&summary.id) {
            Ok(Some(loaded)) => loaded,
            // A corrupt session must not blank the whole project.
            Ok(None) | Err(_) => continue,
        };
        let Some(root) = loaded.metadata.workspace_root.as_deref() else {
            continue;
        };
        if !same_workspace(root, &workspace_root) {
            continue;
        }

        let mut messages = 0u64;
        let mut turns = 0u32;
        let mut active_ms = 0i64;
        let mut thread_tokens = 0u64;
        // Providers this conversation touched, so a chat that switched
        // provider mid-way counts once toward each.
        let mut providers_in_thread: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut first_ts: Option<i64> = None;
        let mut last_ts: Option<i64> = None;

        // Open turn: (user timestamp, prompt preview, last message timestamp).
        let mut open_turn: Option<(i64, String, i64)> = None;
        let close_turn = |turn: Option<(i64, String, i64)>,
                          active: &mut i64,
                          longest: &mut Vec<ProjectLongTurn>| {
            let Some((start, prompt, end)) = turn else {
                return;
            };
            let duration = end - start;
            if duration <= 0 {
                return;
            }
            *active += duration;
            longest.push(ProjectLongTurn {
                thread_id: summary.id.clone(),
                thread_title: summary.title.clone(),
                prompt,
                started_at: start,
                duration_ms: duration,
            });
        };

        for message in loaded.session.messages() {
            messages += 1;
            if message.timestamp > 0 {
                first_ts = Some(first_ts.map_or(message.timestamp, |t| t.min(message.timestamp)));
                last_ts = Some(last_ts.map_or(message.timestamp, |t| t.max(message.timestamp)));
            }

            if message.role == MessageRole::User {
                close_turn(open_turn.take(), &mut active_ms, &mut longest_turns);
                if message.timestamp > 0 {
                    turns += 1;
                    open_turn = Some((
                        message.timestamp,
                        prompt_preview(&message.blocks),
                        message.timestamp,
                    ));
                }
            } else if let Some(turn) = open_turn.as_mut() {
                if message.timestamp > turn.2 {
                    turn.2 = message.timestamp;
                }
            }

            for block in &message.blocks {
                if let ContentBlock::ToolUse { name, .. } = block {
                    if !name.is_empty() {
                        *tools.entry(name.clone()).or_insert(0) += 1;
                    }
                }
            }

            let Some(usage) = &message.usage else {
                continue;
            };
            let input = u64::from(usage.input_tokens)
                + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
            let output = u64::from(usage.output_tokens);
            let cache_read = u64::from(usage.cache_read_input_tokens.unwrap_or(0));
            input_tokens += input;
            output_tokens += output;
            cache_read_tokens += cache_read;
            thread_tokens += input + output;
            requests.record(message.model.as_deref(), usage, &mut providers_in_thread);

            if let Some(date) = local_day(message.timestamp) {
                let day = days.entry(date.clone()).or_insert_with(|| DayUsage {
                    date,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    turns: 0,
                });
                day.input_tokens += input;
                day.output_tokens += output;
                day.cache_read_tokens += cache_read;
                day.turns += 1;
            }
        }
        close_turn(open_turn.take(), &mut active_ms, &mut longest_turns);
        requests.finish_thread(providers_in_thread);

        if let Some(model) = loaded.metadata.model.as_deref() {
            if !model.is_empty() {
                let entry = models.entry(model.to_string()).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += thread_tokens;
            }
        }

        if let Some(ts) = first_ts {
            first_activity = Some(first_activity.map_or(ts, |t: i64| t.min(ts)));
        }
        if let Some(ts) = last_ts {
            last_activity = Some(last_activity.map_or(ts, |t: i64| t.max(ts)));
        }

        let archived = loaded.metadata.archived_at.is_some();
        if archived {
            archived_conversations += 1;
        }
        total_messages += messages;
        total_turns += turns;
        total_active_ms += active_ms;

        conversations.push(ProjectConversation {
            thread_id: summary.id.clone(),
            title: summary.title.clone(),
            created_at: loaded.metadata.created_at.clone(),
            updated_at: loaded.metadata.updated_at.clone(),
            messages,
            turns,
            active_ms,
            span_ms: match (first_ts, last_ts) {
                (Some(a), Some(b)) if b > a => b - a,
                _ => 0,
            },
            tokens: thread_tokens,
            model: loaded.metadata.model.clone(),
            archived,
        });
    }

    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    longest_turns.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
    longest_turns.truncate(LONGEST_TURNS);

    let mut top_tools: Vec<ToolUsage> = tools
        .into_iter()
        .map(|(name, count)| ToolUsage { name, count })
        .collect();
    top_tools.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
    top_tools.truncate(10);

    let mut top_models: Vec<ModelUsage> = models
        .into_iter()
        .map(|(name, (threads, tokens))| ModelUsage {
            name,
            threads,
            tokens,
        })
        .collect();
    top_models.sort_by(|a, b| {
        b.tokens
            .cmp(&a.tokens)
            .then(b.threads.cmp(&a.threads))
            .then(a.name.cmp(&b.name))
    });
    top_models.truncate(8);

    let mut days: Vec<DayUsage> = days.into_values().collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));

    let iso = |ts: Option<i64>| {
        ts.and_then(|t| Local.timestamp_millis_opt(t).single())
            .map(|dt| dt.to_rfc3339())
    };

    let total_requests = requests.total();
    let requests_by_provider = requests.into_providers();

    Ok(ProjectStats {
        workspace_root,
        total_conversations: conversations.len() as u32,
        archived_conversations,
        total_messages,
        total_turns,
        total_active_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        conversations,
        top_models,
        top_tools,
        total_requests,
        requests_by_provider,
        longest_turns,
        days,
        first_activity: iso(first_activity),
        last_activity: iso(last_activity),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_comparison_survives_path_spelling() {
        assert!(same_workspace("E:\\Code\\App", "e:/code/app"));
        assert!(same_workspace("/home/a/proj/", "/home/a/proj"));
        assert!(!same_workspace("/home/a/proj", "/home/a/other"));
    }

    #[test]
    fn prompt_preview_takes_the_first_real_line() {
        let blocks = vec![ContentBlock::Text {
            text: "\n\n  Add task templates  \nsecond line\n".into(),
        }];
        assert_eq!(prompt_preview(&blocks), "Add task templates");
    }

    #[test]
    fn prompt_preview_truncates_with_an_ellipsis() {
        let long = "x".repeat(PROMPT_PREVIEW_CHARS + 40);
        let blocks = vec![ContentBlock::Text { text: long }];
        let out = prompt_preview(&blocks);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), PROMPT_PREVIEW_CHARS + 1);
    }

    #[test]
    fn prompt_preview_handles_a_message_with_no_text_block() {
        assert_eq!(prompt_preview(&[]), "");
    }

    #[test]
    fn local_day_rejects_unset_timestamps() {
        assert_eq!(local_day(0), None);
        assert_eq!(local_day(-5), None);
        assert!(local_day(1_700_000_000_000).is_some());
    }
}
