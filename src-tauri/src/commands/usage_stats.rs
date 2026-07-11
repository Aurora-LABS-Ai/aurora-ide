//! Usage-stats aggregation for the agent window's Profile page.
//!
//! One read-only command, [`usage_stats_get`], scans every session JSONL in
//! the [`SessionStore`] (the single source of truth for chat history) and
//! aggregates the numbers the Profile page renders: lifetime token totals,
//! a per-day activity series, the most-used tools, and the longest task.
//!
//! Everything is derived from data the runtime already persists —
//! `ConversationMessage.usage` (provider-reported token usage per assistant
//! message) and `ConversationMessage.timestamp` (unix ms). No new logging,
//! no telemetry, nothing leaves the machine.
//!
//! Cost/streak math intentionally lives in the frontend: streaks depend on
//! "today" in the user's timezone at render time, and pricing lives in the
//! frontend model catalog.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Local, TimeZone};
use serde::Serialize;
use tauri::State;

use crate::agent_runtime::types::ContentBlock;
use crate::commands::agent_v2::AgentRegistry;

/// Aggregated token activity for one local calendar day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    /// Assistant turns that reported usage this day.
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub name: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongestTask {
    pub thread_id: String,
    pub title: String,
    pub duration_ms: i64,
}

/// Per-model usage, attributed from each thread's `metadata.model` (the
/// model the thread ran with). A whole thread's tokens count toward its
/// recorded model — per-message attribution isn't stored, so this is a
/// thread-granularity approximation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub name: String,
    pub threads: u32,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    /// The machine account name — the profile's display identity. Local
    /// only; never uploaded.
    pub user_name: String,
    pub total_threads: u32,
    pub total_messages: u64,
    pub lifetime_input_tokens: u64,
    pub lifetime_output_tokens: u64,
    pub lifetime_cache_read_tokens: u64,
    /// Ascending by date; days with no activity are absent.
    pub days: Vec<DayUsage>,
    /// Most-used tools, descending, capped at 10.
    pub top_tools: Vec<ToolUsage>,
    /// Most-used models, by tokens descending, capped at 8.
    pub top_models: Vec<ModelUsage>,
    pub longest_task: Option<LongestTask>,
}

/// Unix-ms → local `YYYY-MM-DD`, or `None` for zero/invalid stamps.
fn local_day(ts_ms: i64) -> Option<String> {
    if ts_ms <= 0 {
        return None;
    }
    Local
        .timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// Scan every stored session and aggregate profile stats.
///
/// Linear in total message count; a few hundred threads scan in the low
/// tens of milliseconds since each JSONL is a straight line-parse. Threads
/// that fail to parse are skipped rather than failing the whole page.
#[tauri::command]
pub fn usage_stats_get(registry: State<'_, Arc<AgentRegistry>>) -> Result<UsageStats, String> {
    let store = registry.store().clone();
    let summaries = store
        .list_summaries()
        .map_err(|e| format!("Failed to list threads: {e}"))?;

    let mut days: HashMap<String, DayUsage> = HashMap::new();
    let mut tools: HashMap<String, u32> = HashMap::new();
    let mut models: HashMap<String, (u32, u64)> = HashMap::new();
    let mut total_messages: u64 = 0;
    let mut lifetime_input: u64 = 0;
    let mut lifetime_output: u64 = 0;
    let mut lifetime_cache_read: u64 = 0;
    let mut longest_task: Option<LongestTask> = None;

    for summary in &summaries {
        let loaded = match store.load(&summary.id) {
            Ok(Some(loaded)) => loaded,
            // Missing or corrupt session — the stats page should still
            // render everything else.
            Ok(None) | Err(_) => continue,
        };

        let mut first_ts: Option<i64> = None;
        let mut last_ts: Option<i64> = None;
        let mut thread_tokens: u64 = 0;

        for message in loaded.session.messages() {
            total_messages += 1;

            if message.timestamp > 0 {
                first_ts = Some(first_ts.map_or(message.timestamp, |t| t.min(message.timestamp)));
                last_ts = Some(last_ts.map_or(message.timestamp, |t| t.max(message.timestamp)));
            }

            for block in &message.blocks {
                if let ContentBlock::ToolUse { name, .. } = block {
                    if !name.is_empty() {
                        *tools.entry(name.clone()).or_insert(0) += 1;
                    }
                }
            }

            let Some(usage) = &message.usage else { continue };
            let input = u64::from(usage.input_tokens)
                + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
            let output = u64::from(usage.output_tokens);
            let cache_read = u64::from(usage.cache_read_input_tokens.unwrap_or(0));
            lifetime_input += input;
            lifetime_output += output;
            lifetime_cache_read += cache_read;
            thread_tokens += input + output;

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

        if let Some(model) = loaded.metadata.model.as_deref() {
            if !model.is_empty() {
                let entry = models.entry(model.to_string()).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += thread_tokens;
            }
        }

        if let (Some(first), Some(last)) = (first_ts, last_ts) {
            let duration = last - first;
            if duration > 0 && longest_task.as_ref().is_none_or(|t| duration > t.duration_ms) {
                longest_task = Some(LongestTask {
                    thread_id: summary.id.clone(),
                    title: summary.title.clone(),
                    duration_ms: duration,
                });
            }
        }
    }

    let mut days: Vec<DayUsage> = days.into_values().collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));

    let mut top_tools: Vec<ToolUsage> = tools
        .into_iter()
        .map(|(name, count)| ToolUsage { name, count })
        .collect();
    top_tools.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    top_tools.truncate(10);

    let mut top_models: Vec<ModelUsage> = models
        .into_iter()
        .map(|(name, (threads, tokens))| ModelUsage {
            name,
            threads,
            tokens,
        })
        .collect();
    top_models.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.name.cmp(&b.name)));
    top_models.truncate(8);

    Ok(UsageStats {
        user_name: std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "You".to_string()),
        total_threads: summaries.len() as u32,
        total_messages,
        lifetime_input_tokens: lifetime_input,
        lifetime_output_tokens: lifetime_output,
        lifetime_cache_read_tokens: lifetime_cache_read,
        days,
        top_tools,
        top_models,
        longest_task,
    })
}
