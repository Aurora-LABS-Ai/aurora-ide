//! Permanent, local accounting, independent of the lifetime of a transcript.
//!
//! The database retains usage and activity metadata, never prompt/reply text.
//! New messages carry stable event IDs; copied transcripts retain those IDs.
//! Historical files are reconciled by fingerprint without invoking retention GC.

mod import;
pub(crate) mod schema;
pub(crate) mod stats;
#[cfg(test)]
mod tests;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::agent_runtime::types::{ConversationMessage, TokenUsage};

#[derive(Debug)]
pub(crate) struct Event {
    id: String,
    thread: String,
    timestamp: i64,
    role: String,
    visible: bool,
    model: Option<String>,
    usage: Option<TokenUsage>,
    tools: Vec<String>,
}

impl Event {
    fn from_value(thread: &str, value: &Value, occurrence: usize) -> Result<Self> {
        let role = value["role"].as_str().context("message has no role")?;
        let timestamp = value["timestamp"]
            .as_i64()
            .context("message has no timestamp")?;
        let id = match value["event_id"].as_str().filter(|id| !id.is_empty()) {
            Some(id) => id.to_owned(),
            None => {
                // Content identity survives moving/copying a legacy transcript.
                // Occurrence distinguishes identical records within one source.
                // Normalize old optional fields exactly as the transcript
                // loader does. A copy may omit explicit nulls or add defaults;
                // that serialization change must not manufacture another bill.
                let canonical = serde_json::from_value::<ConversationMessage>(value.clone())
                    .ok()
                    .map(serde_json::to_value)
                    .transpose()?;
                let digest =
                    Sha256::digest(serde_json::to_vec(canonical.as_ref().unwrap_or(value))?);
                format!("legacy:{digest:x}:{occurrence}")
            }
        };
        let tools = value["blocks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .filter_map(|b| {
                b["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .collect();
        Ok(Self {
            id,
            thread: thread.to_owned(),
            timestamp,
            role: role.to_owned(),
            visible: true,
            model: value["model"].as_str().map(str::to_owned),
            usage: value
                .get("usage")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()?,
            tools,
        })
    }
}

pub struct UsageLedger {
    conn: Mutex<Connection>,
    root: PathBuf,
    import_lock: Mutex<()>,
    // Failed writes remain retryable even for billed responses not kept in chat.
    pending: Mutex<Vec<Event>>,
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl std::fmt::Debug for UsageLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsageLedger")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl UsageLedger {
    /// Schema creation belongs to the app migration; this opens its own connection.
    pub fn open(database: &Path, root: PathBuf) -> Result<Self> {
        let conn =
            Connection::open(database).with_context(|| format!("open {}", database.display()))?;
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        // Fail explicitly if the app did not run the accounting migration.
        conn.prepare("SELECT event_id FROM usage_events LIMIT 0")?;
        Ok(Self {
            conn: Mutex::new(conn),
            root,
            import_lock: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
            notify: None,
        })
    }

    pub fn with_notifier(mut self, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.notify = Some(notify);
        self
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("usage database lock poisoned"))
    }

    pub fn record(&self, thread: &str, message: &ConversationMessage, visible: bool) -> Result<()> {
        let mut event = Event::from_value(thread, &serde_json::to_value(message)?, 0)?;
        event.visible = visible;
        self.pending
            .lock()
            .map_err(|_| anyhow::anyhow!("usage queue lock poisoned"))?
            .push(event);
        self.flush()?;
        if let Some(notify) = &self.notify {
            notify();
        }
        Ok(())
    }

    fn flush(&self) -> Result<()> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("usage queue lock poisoned"))?;
        if pending.is_empty() {
            return Ok(());
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        for event in pending.iter() {
            insert_event(&tx, event)?;
        }
        tx.commit()?;
        pending.clear();
        Ok(())
    }

    pub fn stats(&self) -> Result<stats::UsageStats> {
        self.reconcile()?;
        self.flush()?;
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let result = stats::read(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}

fn insert_event(conn: &Connection, event: &Event) -> Result<()> {
    let (provider, model) = stats::split_model_selection(event.model.as_deref());
    let empty = TokenUsage::default();
    let usage = event.usage.as_ref().unwrap_or(&empty);
    conn.execute(
        "INSERT INTO usage_events (event_id,thread_id,timestamp_ms,role,visible_message,
         provider_id,model,has_usage,input_tokens,output_tokens,cache_write_tokens,
         cache_read_tokens,estimated,cost_usd,tools_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(event_id) DO UPDATE SET
         visible_message=MAX(usage_events.visible_message,excluded.visible_message)",
        params![
            event.id,
            event.thread,
            event.timestamp,
            event.role,
            event.visible,
            provider,
            model,
            event.usage.is_some(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_creation_input_tokens.unwrap_or(0),
            usage.cache_read_input_tokens.unwrap_or(0),
            usage.estimated == Some(true),
            usage.cost_usd,
            serde_json::to_string(&event.tools)?
        ],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO usage_threads (thread_id,title,surface) VALUES (?1,'','build')",
        [&event.thread],
    )?;
    Ok(())
}
