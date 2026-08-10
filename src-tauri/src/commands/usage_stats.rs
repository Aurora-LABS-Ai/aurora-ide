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

/// Exact API-request counts for one model.
///
/// A "request" is one call to the provider — NOT one thing the user asked
/// for. An agent turn issues one request per tool iteration, so a single
/// question that reads five files and edits two is seven-plus requests. That
/// is the number that maps to a rate limit and to a bill, which is why it is
/// counted rather than turns.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestUsage {
    /// Model key with the provider prefix stripped (`gpt-5.6-sol`).
    pub model: String,
    pub requests: u32,
    /// Requests whose counts are Aurora's estimate, not provider-reported.
    pub estimated_requests: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
}

/// Request counts for one provider, with its models nested underneath.
///
/// Grouped this way because that is how the question is actually asked —
/// "how much have I sent to this provider" first, "and to which model" second.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequestUsage {
    /// The provider ROW id. A readable slug for built-ins, a generated UUID
    /// for user-added providers — so the frontend resolves it to a display
    /// name and never renders this raw.
    pub provider_id: String,
    pub requests: u32,
    pub estimated_requests: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    /// Threads that used this provider at all.
    pub threads: u32,
    /// Descending by request count.
    pub models: Vec<ModelRequestUsage>,
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
    /// Exact API-request counts, by provider, each with its models nested.
    /// Descending by request count.
    pub requests_by_provider: Vec<ProviderRequestUsage>,
    /// Every API request ever sent, across all providers. The headline number
    /// — one call per tool iteration, so it is far larger than the turn count.
    pub total_requests: u32,
    pub longest_task: Option<LongestTask>,
}

/// Running tally of API requests, grouped by provider then model.
///
/// Shared by the Profile page (all threads) and the Project panel (one
/// workspace) so the two can never disagree about what counts as a request —
/// the numbers sit side by side in the product and a second implementation
/// would drift the first time either was touched.
#[derive(Default)]
pub struct RequestTally {
    /// provider_id -> (model_key -> counts).
    by_provider: HashMap<String, HashMap<String, ModelRequestUsage>>,
    threads: HashMap<String, u32>,
    total: u32,
}

impl RequestTally {
    /// Record one API request from a message that carried usage.
    ///
    /// Call this for EVERY message with usage, including the calls that
    /// process tool results and the compaction summariser: each is a real
    /// call against a rate limit and a bill, and excluding them would make
    /// the count describe turns rather than requests.
    pub fn record(
        &mut self,
        model_selection: Option<&str>,
        usage: &crate::agent_runtime::types::TokenUsage,
        seen_in_thread: &mut std::collections::HashSet<String>,
    ) {
        let input = u64::from(usage.input_tokens)
            + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
        let output = u64::from(usage.output_tokens);
        let cache_read = u64::from(usage.cache_read_input_tokens.unwrap_or(0));

        self.total = self.total.saturating_add(1);
        let (provider_id, model_key) = split_model_selection(model_selection);
        seen_in_thread.insert(provider_id.clone());
        let entry = self
            .by_provider
            .entry(provider_id)
            .or_default()
            .entry(model_key.clone())
            .or_insert_with(|| ModelRequestUsage {
                model: model_key,
                ..Default::default()
            });
        entry.requests = entry.requests.saturating_add(1);
        if usage.estimated == Some(true) {
            entry.estimated_requests = entry.estimated_requests.saturating_add(1);
        }
        entry.input_tokens += input;
        entry.output_tokens += output;
        entry.cache_read_tokens += cache_read;
    }

    /// Fold one finished thread's provider set into the thread counts.
    pub fn finish_thread(&mut self, seen_in_thread: std::collections::HashSet<String>) {
        for provider in seen_in_thread {
            *self.threads.entry(provider).or_insert(0) += 1;
        }
    }

    pub fn total(&self) -> u32 {
        self.total
    }

    /// Roll models up into their providers, both sorted by request count.
    ///
    /// Deliberately NOT truncated: this is an accounting view, and a list that
    /// quietly dropped its tail would make the provider totals disagree with
    /// the models shown under them.
    pub fn into_providers(self) -> Vec<ProviderRequestUsage> {
        let threads = self.threads;
        let mut out: Vec<ProviderRequestUsage> = self
            .by_provider
            .into_iter()
            .map(|(provider_id, by_model)| {
                let mut models: Vec<ModelRequestUsage> = by_model.into_values().collect();
                models.sort_by(|a, b| {
                    b.requests
                        .cmp(&a.requests)
                        .then_with(|| a.model.cmp(&b.model))
                });
                let thread_count = threads.get(&provider_id).copied().unwrap_or(0);
                ProviderRequestUsage {
                    requests: models.iter().map(|m| m.requests).sum(),
                    estimated_requests: models.iter().map(|m| m.estimated_requests).sum(),
                    input_tokens: models.iter().map(|m| m.input_tokens).sum(),
                    output_tokens: models.iter().map(|m| m.output_tokens).sum(),
                    cache_read_tokens: models.iter().map(|m| m.cache_read_tokens).sum(),
                    provider_id,
                    threads: thread_count,
                    models,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.requests
                .cmp(&a.requests)
                .then_with(|| a.provider_id.cmp(&b.provider_id))
        });
        out
    }
}

/// Split a `"{provider_id}:{model_key}"` selection into its two halves.
///
/// Only the FIRST colon separates them: a provider id never contains one, a
/// model key can (`openai/gpt-5.6:preview`). Messages recorded before the
/// runtime persisted a model fall into a shared unattributed bucket rather
/// than being credited to whichever provider is configured now.
fn split_model_selection(selection: Option<&str>) -> (String, String) {
    let Some(raw) = selection.map(str::trim).filter(|s| !s.is_empty()) else {
        return (String::new(), String::new());
    };
    match raw.find(':') {
        Some(at) if at > 0 => (raw[..at].to_string(), raw[at + 1..].to_string()),
        // No provider prefix — treat the whole thing as the model key.
        _ => (String::new(), raw.to_string()),
    }
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
    // Keyed off the per-message `model` the runtime now records, so this is
    // EXACT per-request attribution rather than the thread-granularity
    // approximation `top_models` still uses.
    let mut requests = RequestTally::default();
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
        // Providers this thread touched, so a chat that switched provider
        // mid-way counts once toward each rather than once toward whichever
        // one happened to be recorded on its metadata.
        let mut providers_in_thread: std::collections::HashSet<String> =
            std::collections::HashSet::new();

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

            let Some(usage) = &message.usage else {
                continue;
            };
            let input = u64::from(usage.input_tokens)
                + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
            let output = u64::from(usage.output_tokens);
            let cache_read = u64::from(usage.cache_read_input_tokens.unwrap_or(0));
            lifetime_input += input;
            lifetime_output += output;
            lifetime_cache_read += cache_read;
            thread_tokens += input + output;

            // One message carrying usage == one API request. That deliberately
            // includes the calls made to process tool RESULTS (an agent turn
            // issues one per tool iteration) and the compaction summariser,
            // because each of those is a real call against a rate limit.
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

        requests.finish_thread(providers_in_thread);

        if let Some(model) = loaded.metadata.model.as_deref() {
            if !model.is_empty() {
                let entry = models.entry(model.to_string()).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += thread_tokens;
            }
        }

        if let (Some(first), Some(last)) = (first_ts, last_ts) {
            let duration = last - first;
            if duration > 0
                && longest_task
                    .as_ref()
                    .is_none_or(|t| duration > t.duration_ms)
            {
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

    let total_requests = requests.total();
    let requests_by_provider = requests.into_providers();

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
        requests_by_provider,
        total_requests,
        longest_task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selection_splits_on_its_first_colon_only() {
        // A provider id never contains a colon; a model key can.
        assert_eq!(
            split_model_selection(Some("openai:gpt-5.6-sol")),
            ("openai".into(), "gpt-5.6-sol".into())
        );
        assert_eq!(
            split_model_selection(Some("gw:openai/gpt-5.6:preview")),
            ("gw".into(), "openai/gpt-5.6:preview".into())
        );
        // A user-added provider's id is a UUID — it must still split cleanly.
        assert_eq!(
            split_model_selection(Some("6fa1043d-2c79-4867-8956-9645decd35e4:agnes-2.5-flash")),
            (
                "6fa1043d-2c79-4867-8956-9645decd35e4".into(),
                "agnes-2.5-flash".into()
            )
        );
    }

    #[test]
    fn a_message_with_no_model_is_unattributed_not_misattributed() {
        // Requests recorded before the runtime persisted a model must NOT be
        // credited to whichever provider happens to be configured now.
        assert_eq!(split_model_selection(None), (String::new(), String::new()));
        assert_eq!(
            split_model_selection(Some("   ")),
            (String::new(), String::new())
        );
    }

    #[test]
    fn a_bare_model_key_keeps_its_whole_name() {
        assert_eq!(
            split_model_selection(Some("gpt-5.6-sol")),
            (String::new(), "gpt-5.6-sol".into())
        );
        // A leading colon is not a provider prefix.
        assert_eq!(
            split_model_selection(Some(":weird")),
            (String::new(), ":weird".into())
        );
    }
}
