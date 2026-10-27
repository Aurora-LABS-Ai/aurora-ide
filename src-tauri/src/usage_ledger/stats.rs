//! Profile projections over permanent accounting metadata.

use chrono::{Local, TimeZone};
use serde::Serialize;
use std::collections::HashMap;

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

/// The longest single TURN ever run — one question, and everything the agent
/// did before it needed you again.
///
/// This used to be a thread's whole elapsed span (`last - first`), which is not
/// a task: replying once to a two-month-old chat reported a 1484-hour task, and
/// the card sat next to real figures like Peak day so it read as one. What a
/// person means by "longest task" is how long the agent ran unattended, and
/// that is a turn — the same unit `project_stats` measures for exactly this
/// reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongestTask {
    pub thread_id: String,
    pub title: String,
    pub duration_ms: i64,
}

/// A turn in progress: when the user asked, and the last activity seen since.
type OpenTurn = (i64, i64);

/// Close a turn and keep it if it is the longest seen.
///
/// A turn with no activity after the question (zero or negative span) is not a
/// task the agent ran — it is a message that was never answered.
fn record_turn(
    turn: Option<OpenTurn>,
    thread_id: &str,
    title: &str,
    longest: &mut Option<LongestTask>,
) {
    let Some((start, end)) = turn else {
        return;
    };
    let duration = end - start;
    if duration <= 0 {
        return;
    }
    if longest
        .as_ref()
        .is_none_or(|best| duration > best.duration_ms)
    {
        *longest = Some(LongestTask {
            thread_id: thread_id.to_string(),
            title: title.to_string(),
            duration_ms: duration,
        });
    }
}

/// Per-model usage, attributed to the model recorded on each request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub name: String,
    pub threads: u32,
    pub tokens: u64,
}

/// One model's lifetime use, summed across EVERY provider it was reached
/// through.
///
/// `ModelUsage` keys on the full `provider:model` selection, so a model used
/// through seven gateways was seven rows that all read "GPT-5.6 Sol" on the
/// Profile page. This is the same usage keyed on the model alone, with the
/// providers kept as a list so the page can say "via 7 providers" and can merge
/// two keys the catalog labels the same without double-counting a provider.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTotal {
    /// Model key with the provider prefix stripped (`gpt-5.6-sol`).
    pub model: String,
    /// Provider row ids that served it, sorted.
    pub providers: Vec<String>,
    pub requests: u32,
    /// Input (incl. cache writes) + output.
    pub tokens: u64,
    /// Input incl. cache writes; `tokens` minus `output_tokens`.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    /// Estimated USD cost of the requests that had a price (see `CostSummary`).
    pub cost_usd: f64,
    /// Requests counted in `cost_usd`; the rest of `requests` had no price.
    pub priced_requests: u32,
}

/// What the ledger's usage would cost at the prices set on each model.
///
/// A provider-reported cost wins when the request carries one. Otherwise the
/// request is priced from its own provider's model row, and failing that from
/// the cheapest priced row with the same model key, so a subscription gateway
/// that never set prices still reads at the model's list price. Requests with
/// no price anywhere are left out and counted, never guessed at zero.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummary {
    pub usd: f64,
    pub priced_requests: u32,
    /// Of `priced_requests`, how many used a cost the provider reported.
    pub reported_requests: u32,
}

/// Per-million-token USD prices of one model row.
#[derive(Debug, Clone, Copy)]
struct ModelPrice {
    input: f64,
    cache_read: f64,
    output: f64,
    cache_write: f64,
}

impl ModelPrice {
    fn cost(&self, input: u64, cache_write: u64, cache_read: u64, output: u64) -> f64 {
        (input as f64 * self.input
            + cache_write as f64 * self.cache_write
            + cache_read as f64 * self.cache_read
            + output as f64 * self.output)
            / 1_000_000.0
    }
}

/// Prices keyed on (provider id, model key), plus a per-model fallback.
#[derive(Default)]
struct PriceBook {
    exact: HashMap<(String, String), ModelPrice>,
    by_model: HashMap<String, ModelPrice>,
}

impl PriceBook {
    /// USD rows only: a price in another currency is never added into a
    /// dollar total. A missing cache price falls back to the input price,
    /// which is what an uncached request is charged. The settings tables live
    /// in the same database; a ledger opened without them has no prices.
    fn load(conn: &rusqlite::Connection) -> Self {
        let mut book = PriceBook::default();
        let Ok(mut stmt) = conn.prepare(
            "SELECT provider_id,model_key,price_cache_miss_per_mtok,price_cache_hit_per_mtok,
                    price_output_per_mtok,price_cache_write_per_mtok
             FROM provider_models
             WHERE (price_cache_miss_per_mtok IS NOT NULL OR price_output_per_mtok IS NOT NULL)
               AND COALESCE(UPPER(price_currency),'USD')='USD'",
        ) else {
            return book;
        };
        let Ok(rows) = stmt.query_map([], |r| {
            let input = r.get::<_, Option<f64>>(2)?.unwrap_or(0.0);
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                ModelPrice {
                    input,
                    cache_read: r.get::<_, Option<f64>>(3)?.unwrap_or(input),
                    output: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                    cache_write: r.get::<_, Option<f64>>(5)?.unwrap_or(input),
                },
            ))
        }) else {
            return book;
        };
        for (provider, model, price) in rows.flatten() {
            book.by_model
                .entry(model.clone())
                .and_modify(|p| {
                    if price.input + price.output < p.input + p.output {
                        *p = price;
                    }
                })
                .or_insert(price);
            book.exact.insert((provider, model), price);
        }
        book
    }

    fn get(&self, provider: &str, model: &str) -> Option<&ModelPrice> {
        self.exact
            .get(&(provider.to_string(), model.to_string()))
            .or_else(|| self.by_model.get(model))
    }
}

/// One project's lifetime use: every thread that ran in one workspace folder,
/// or every Aurora Chat conversation together.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// The workspace folder as recorded, `None` for Aurora Chat and for build
    /// threads imported before a folder was saved.
    pub root: Option<String>,
    /// `"chat"` for Aurora Chat, `"build"` for project threads.
    pub surface: String,
    pub requests: u32,
    /// Input (incl. cache writes) + output.
    pub tokens: u64,
    pub cache_read_tokens: u64,
    pub threads: u32,
}

/// Usage recorded before the runtime saved which model answered.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnattributedUsage {
    pub requests: u32,
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
    /// Every tool ever called from a visible message, descending. Not capped:
    /// the Profile page lists them all and sums them for the total.
    pub top_tools: Vec<ToolUsage>,
    /// Most-used models, by tokens descending, capped at 8.
    pub top_models: Vec<ModelUsage>,
    /// Every model ever used, merged across providers, by tokens descending.
    /// Excludes unattributed usage, which is reported on its own.
    pub models: Vec<ModelTotal>,
    pub unattributed: UnattributedUsage,
    /// Exact API-request counts, by provider, each with its models nested.
    /// Descending by request count.
    pub requests_by_provider: Vec<ProviderRequestUsage>,
    /// Every API request ever sent, across all providers. The headline number
    /// — one call per tool iteration, so it is far larger than the turn count.
    pub total_requests: u32,
    pub longest_task: Option<LongestTask>,
    /// Requests by local weekday (Monday first) and hour: 7 rows of 24.
    pub hour_of_week: Vec<Vec<u32>>,
    /// Usage per workspace folder, Aurora Chat as one entry. By tokens
    /// descending, not capped.
    pub projects: Vec<ProjectUsage>,
    pub cost: CostSummary,
}

/// Local (weekday from Monday, hour) of a stamp, or `None` for zero/invalid.
fn hour_slot(ts_ms: i64) -> Option<(usize, usize)> {
    use chrono::{Datelike, Timelike};
    if ts_ms <= 0 {
        return None;
    }
    let dt = Local.timestamp_millis_opt(ts_ms).single()?;
    Some((dt.weekday().num_days_from_monday() as usize, dt.hour() as usize))
}

/// The key a thread's usage is grouped under on the Projects list.
///
/// Aurora Chat conversations have no folder and read as one entry. A folder
/// is compared case-insensitively with either slash, because Windows paths
/// reach the ledger spelled both ways from different import layouts.
fn project_key(root: Option<&str>, surface: &str) -> String {
    if surface == "chat" {
        return "chat".to_string();
    }
    match root.map(str::trim).filter(|r| !r.is_empty()) {
        Some(root) => root
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase(),
        None => String::new(),
    }
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

/// Running per-model totals keyed on the model alone (see `ModelTotal`).
#[derive(Default)]
struct ModelTotals {
    by_model: HashMap<String, (std::collections::BTreeSet<String>, ModelTotal)>,
    unattributed: UnattributedUsage,
}

impl ModelTotals {
    /// `input` already includes cache writes, as everywhere in the ledger.
    /// `cost` is this request's price, `None` when it had none.
    fn record(
        &mut self,
        selection: Option<&str>,
        input: u64,
        output: u64,
        cache_read: u64,
        cost: Option<f64>,
    ) {
        let (provider_id, model) = split_model_selection(selection);
        if model.is_empty() {
            self.unattributed.requests = self.unattributed.requests.saturating_add(1);
            self.unattributed.tokens += input + output;
            return;
        }
        let (providers, total) = self.by_model.entry(model).or_default();
        if !provider_id.is_empty() {
            providers.insert(provider_id);
        }
        total.requests = total.requests.saturating_add(1);
        total.tokens += input + output;
        total.input_tokens += input;
        total.output_tokens += output;
        total.cache_read_tokens += cache_read;
        if let Some(cost) = cost {
            total.cost_usd += cost;
            total.priced_requests = total.priced_requests.saturating_add(1);
        }
    }

    fn finish(self) -> (Vec<ModelTotal>, UnattributedUsage) {
        let mut out: Vec<ModelTotal> = self
            .by_model
            .into_iter()
            .map(|(model, (providers, total))| ModelTotal {
                model,
                providers: providers.into_iter().collect(),
                ..total
            })
            .collect();
        out.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.model.cmp(&b.model)));
        (out, self.unattributed)
    }
}

/// Split a `"{provider_id}:{model_key}"` selection into its two halves.
///
/// Only the FIRST colon separates them: a provider id never contains one, a
/// model key can (`openai/gpt-5.6:preview`). Messages recorded before the
/// runtime persisted a model fall into a shared unattributed bucket rather
/// than being credited to whichever provider is configured now.
pub(super) fn split_model_selection(selection: Option<&str>) -> (String, String) {
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

pub(super) fn read(conn: &rusqlite::Connection) -> anyhow::Result<UsageStats> {
    let mut titles = HashMap::<String, String>::new();
    // thread -> project key; project key -> totals (threads counted once each).
    let mut thread_project = HashMap::<String, String>::new();
    let mut projects = HashMap::<String, (ProjectUsage, std::collections::HashSet<String>)>::new();
    let mut stmt = conn.prepare("SELECT thread_id,title,workspace_root,surface FROM usage_threads")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, title, root, surface) = row?;
        let key = project_key(root.as_deref(), &surface);
        projects.entry(key.clone()).or_insert_with(|| {
            (
                ProjectUsage {
                    root: root.filter(|_| surface != "chat"),
                    surface: surface.clone(),
                    ..Default::default()
                },
                Default::default(),
            )
        });
        thread_project.insert(id.clone(), key);
        titles.insert(id, title);
    }
    let mut hour_of_week = vec![vec![0u32; 24]; 7];
    let prices = PriceBook::load(conn);
    let mut cost = CostSummary::default();
    let mut days = HashMap::<String, DayUsage>::new();
    let mut tools = HashMap::<String, u32>::new();
    let mut models = HashMap::<String, (std::collections::HashSet<String>, u64)>::new();
    let mut requests = RequestTally::default();
    let mut totals = ModelTotals::default();
    let mut total_messages = 0;
    let mut lifetime_input = 0;
    let mut lifetime_output = 0;
    let mut lifetime_cache_read = 0;
    let mut longest_task = None;
    let mut current_thread = String::new();
    let mut open_turn: Option<OpenTurn> = None;
    let mut providers_in_thread = std::collections::HashSet::new();
    let mut stmt = conn.prepare(
        "SELECT thread_id,timestamp_ms,role,visible_message,provider_id,model,has_usage,
         input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,estimated,cost_usd,tools_json
         FROM usage_events ORDER BY thread_id,timestamp_ms,rowid"
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let thread: String = row.get(0)?;
        let timestamp: i64 = row.get(1)?;
        let role: String = row.get(2)?;
        let visible: bool = row.get(3)?;
        if thread != current_thread {
            record_turn(
                open_turn.take(),
                &current_thread,
                titles
                    .get(&current_thread)
                    .map(String::as_str)
                    .unwrap_or(""),
                &mut longest_task,
            );
            requests.finish_thread(std::mem::take(&mut providers_in_thread));
            current_thread = thread.clone();
        }
        if visible {
            total_messages += 1;
        }
        if role == "user" {
            record_turn(
                open_turn.take(),
                &thread,
                titles.get(&thread).map(String::as_str).unwrap_or(""),
                &mut longest_task,
            );
            if timestamp > 0 {
                open_turn = Some((timestamp, timestamp));
            }
        } else if let Some(turn) = open_turn.as_mut() {
            turn.1 = turn.1.max(timestamp);
        }
        if visible {
            let names: Vec<String> = serde_json::from_str(&row.get::<_, String>(13)?)?;
            for name in names {
                *tools.entry(name).or_default() += 1;
            }
        }
        if !row.get::<_, bool>(6)? {
            continue;
        }
        let provider: String = row.get(4)?;
        let model: String = row.get(5)?;
        let reported_cost: Option<f64> = row.get(12)?;
        let request_cost = match reported_cost.filter(|c| c.is_finite() && *c >= 0.0) {
            Some(c) => {
                cost.reported_requests = cost.reported_requests.saturating_add(1);
                Some(c)
            }
            None if model.is_empty() => None,
            None => match prices.get(&provider, &model) {
                Some(price) => {
                    let count = |i: usize| row.get::<_, u32>(i).map(u64::from);
                    Some(price.cost(count(7)?, count(9)?, count(10)?, count(8)?))
                }
                None => None,
            },
        };
        if let Some(c) = request_cost {
            cost.usd += c;
            cost.priced_requests = cost.priced_requests.saturating_add(1);
        }
        let selection = if provider.is_empty() {
            model
        } else {
            format!("{provider}:{model}")
        };
        let usage = crate::agent_runtime::types::TokenUsage {
            input_tokens: row.get(7)?,
            output_tokens: row.get(8)?,
            cache_creation_input_tokens: Some(row.get(9)?),
            cache_read_input_tokens: Some(row.get(10)?),
            estimated: Some(row.get(11)?),
            cost_usd: row.get(12)?,
        };
        let input = u64::from(usage.input_tokens)
            + u64::from(usage.cache_creation_input_tokens.unwrap_or(0));
        let output = u64::from(usage.output_tokens);
        let cache = u64::from(usage.cache_read_input_tokens.unwrap_or(0));
        lifetime_input += input;
        lifetime_output += output;
        lifetime_cache_read += cache;
        requests.record(Some(&selection), &usage, &mut providers_in_thread);
        totals.record(Some(&selection), input, output, cache, request_cost);
        if let Some((weekday, hour)) = hour_slot(timestamp) {
            hour_of_week[weekday][hour] = hour_of_week[weekday][hour].saturating_add(1);
        }
        // A thread with usage but no `usage_threads` row is a live chat the
        // import has not described yet; it groups with the folderless threads.
        let key = thread_project.get(&thread).cloned().unwrap_or_default();
        let (project, threads) = projects.entry(key).or_insert_with(|| {
            (
                ProjectUsage {
                    surface: "build".into(),
                    ..Default::default()
                },
                Default::default(),
            )
        });
        project.requests = project.requests.saturating_add(1);
        project.tokens += input + output;
        project.cache_read_tokens += cache;
        threads.insert(thread.clone());
        let entry = models.entry(selection).or_default();
        entry.0.insert(thread);
        entry.1 += input + output;
        if let Some(date) = local_day(timestamp) {
            let day = days.entry(date.clone()).or_insert(DayUsage {
                date,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                turns: 0,
            });
            day.input_tokens += input;
            day.output_tokens += output;
            day.cache_read_tokens += cache;
            day.turns += 1;
        }
    }
    record_turn(
        open_turn,
        &current_thread,
        titles
            .get(&current_thread)
            .map(String::as_str)
            .unwrap_or(""),
        &mut longest_task,
    );
    requests.finish_thread(providers_in_thread);
    let mut days: Vec<_> = days.into_values().collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));
    let mut top_tools: Vec<_> = tools
        .into_iter()
        .map(|(name, count)| ToolUsage { name, count })
        .collect();
    top_tools.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    let mut projects: Vec<ProjectUsage> = projects
        .into_values()
        .filter(|(project, _)| project.requests > 0)
        .map(|(project, threads)| ProjectUsage {
            threads: threads.len() as u32,
            ..project
        })
        .collect();
    projects.sort_by(|a, b| {
        b.tokens
            .cmp(&a.tokens)
            .then_with(|| a.root.cmp(&b.root))
    });
    let mut top_models: Vec<_> = models
        .into_iter()
        .map(|(name, (threads, tokens))| ModelUsage {
            name,
            threads: threads.len() as u32,
            tokens,
        })
        .collect();
    top_models.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.name.cmp(&b.name)));
    top_models.truncate(8);
    let (model_totals, unattributed) = totals.finish();
    Ok(UsageStats {
        user_name: std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "You".into()),
        total_threads: titles.len() as u32,
        total_messages,
        lifetime_input_tokens: lifetime_input,
        lifetime_output_tokens: lifetime_output,
        lifetime_cache_read_tokens: lifetime_cache_read,
        days,
        top_tools,
        top_models,
        models: model_totals,
        unattributed,
        total_requests: requests.total(),
        requests_by_provider: requests.into_providers(),
        longest_task,
        hour_of_week,
        projects,
        cost,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600_000;

    /// Feed turns through `record_turn` the way the message loop does.
    fn longest_of(turns: &[(i64, i64)]) -> Option<i64> {
        let mut longest = None;
        for turn in turns {
            record_turn(Some(*turn), "t", "Title", &mut longest);
        }
        longest.map(|t| t.duration_ms)
    }

    #[test]
    fn a_task_is_one_turn_not_the_life_of_the_chat() {
        // The bug this replaced: a chat opened in June and replied to in August
        // reported a 1484-hour "task". Two short turns two months apart are two
        // short turns.
        let june = 0;
        let august = 62 * 24 * HOUR;
        assert_eq!(
            longest_of(&[(june, june + 2 * HOUR), (august, august + HOUR)]),
            Some(2 * HOUR),
        );
    }

    #[test]
    fn keeps_the_longest_run_not_the_last_one() {
        assert_eq!(
            longest_of(&[(0, 5 * HOUR), (HOUR, HOUR + 60_000)]),
            Some(5 * HOUR)
        );
    }

    #[test]
    fn a_question_that_was_never_answered_is_not_a_task() {
        // Start == end means the agent did nothing after being asked, and a
        // negative span means the timestamps are corrupt. Neither is a run.
        assert_eq!(longest_of(&[(500, 500)]), None);
        assert_eq!(longest_of(&[(900, 100)]), None);
    }

    #[test]
    fn a_thread_with_no_turns_reports_nothing() {
        let mut longest = None;
        record_turn(None, "t", "Title", &mut longest);
        assert!(longest.is_none());
    }

    #[test]
    fn prices_come_from_the_own_row_then_the_cheapest_same_model_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE provider_models (provider_id TEXT, model_key TEXT,
               price_cache_miss_per_mtok REAL, price_cache_hit_per_mtok REAL,
               price_output_per_mtok REAL, price_cache_write_per_mtok REAL, price_currency TEXT);
             INSERT INTO provider_models VALUES ('openai','sol',5,0.5,30,NULL,'USD');
             INSERT INTO provider_models VALUES ('gw','sol',4,NULL,20,NULL,NULL);
             INSERT INTO provider_models VALUES ('cny','glm',3,NULL,9,NULL,'CNY');",
        )
        .unwrap();
        let book = PriceBook::load(&conn);
        let own = book.get("openai", "sol").unwrap();
        // 1M input, 1M cache write (charged as input when unset), 2M cache read, 1M output.
        assert_eq!(own.cost(1_000_000, 1_000_000, 2_000_000, 1_000_000), 5.0 + 5.0 + 1.0 + 30.0);
        // A gateway with no row of its own reads at the cheapest list price.
        assert_eq!(book.get("claude-code", "sol").unwrap().output, 20.0);
        // Never mix currencies, never invent a price.
        assert!(book.get("cny", "glm").is_none());
        assert!(book.get("x", "unknown").is_none());
        // A ledger database without the settings tables simply has no prices.
        let bare = rusqlite::Connection::open_in_memory().unwrap();
        assert!(PriceBook::load(&bare).get("openai", "sol").is_none());
    }

    #[test]
    fn one_folder_spelled_two_ways_is_one_project() {
        assert_eq!(
            project_key(Some("E:/VOID-EDITOR/Aurora-Agent-IDE/"), "build"),
            project_key(Some(r"e:\void-editor\aurora-agent-ide"), "build"),
        );
        // Aurora Chat is one entry whatever folder a thread recorded.
        assert_eq!(project_key(Some(r"C:\x"), "chat"), "chat");
        assert_eq!(project_key(None, "build"), "");
        assert_eq!(project_key(Some("  "), "build"), "");
    }

    #[test]
    fn hour_slot_is_local_weekday_from_monday_and_hour() {
        let stamp = Local
            .with_ymd_and_hms(2026, 10, 19, 21, 30, 0) // a Monday
            .single()
            .unwrap()
            .timestamp_millis();
        assert_eq!(hour_slot(stamp), Some((0, 21)));
        assert_eq!(hour_slot(stamp + 6 * 24 * HOUR), Some((6, 21)));
        assert_eq!(hour_slot(0), None);
    }

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
    fn one_model_through_many_providers_is_one_row() {
        // The Profile page listed gpt-5.6-sol once per gateway, so the same
        // name appeared three times. Keyed on the model, it is one row that
        // knows every provider it came through.
        let mut totals = ModelTotals::default();
        totals.record(Some("kenari:gpt-5.6-sol"), 90, 10, 400, Some(1.5));
        totals.record(Some("codex:gpt-5.6-sol"), 45, 5, 200, None);
        totals.record(Some("kenari:gpt-5.6-sol"), 8, 2, 0, Some(0.25));
        totals.record(Some("kenari:glm-5.3"), 20, 0, 0, None);
        totals.record(None, 7, 0, 3, None);
        let (models, unattributed) = totals.finish();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "gpt-5.6-sol");
        assert_eq!(models[0].tokens, 160);
        assert_eq!(models[0].requests, 3);
        // The split the Models list shows, summed across providers too.
        assert_eq!(
            (models[0].input_tokens, models[0].output_tokens, models[0].cache_read_tokens),
            (143, 17, 600)
        );
        // Cost covers only the priced requests, and says how many those were.
        assert_eq!((models[0].cost_usd, models[0].priced_requests), (1.75, 2));
        assert_eq!(models[0].providers, vec!["codex".to_string(), "kenari".to_string()]);
        // No recorded model is reported apart, never as a model row.
        assert_eq!(unattributed.requests, 1);
        assert_eq!(unattributed.tokens, 7);
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
