//! The task registry — what every sub-agent is doing right now.
//!
//! One [`TaskRecord`] per agent, keyed by its id, kept in memory for the life
//! of the process. It is a cache of the live state (running, finished, how
//! far along) and the handle to stop a background run. It is not the record
//! of what happened — that is the child's transcript and sidecar on disk,
//! which survive this map being emptied.
//!
//! Three things live here and nowhere else:
//!
//! - the cancel token of a running agent, so a stop button can reach it;
//! - the `notified` flag, which makes a run's completion report go out once;
//! - the wakeup a `get_task_output` check waits on.
//!
//! Messages for a running agent are NOT here: they go into the agent's own
//! conversation queue (the same slot a person's mid-turn message uses), so
//! there is one queue per conversation and one place that drains it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::host::SubagentUsage;

/// Where an agent is in its life. One-way except for a resume, which puts a
/// finished agent back into `Running` under the same id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Killed,
}

impl TaskStatus {
    #[must_use]
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }
}

/// What the parent (and the window) can see of one agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub agent_id: String,
    pub parent_thread_id: String,
    pub agent_type: String,
    /// The name the parent gave it, when it gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub description: String,
    pub status: TaskStatus,
    pub background: bool,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    /// The child's final message, once there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub usage: SubagentUsage,
    pub notified: bool,
    /// How many runs so far: 1, plus one per resume.
    pub runs: u32,
    /// `providerId:modelKey` it runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The prompt size of its latest model call: how full its context is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
}

impl TaskSnapshot {
    /// What the files say about an agent nobody is running right now.
    #[must_use]
    pub fn from_sidecar(sidecar: &super::store::AgentSidecar) -> Self {
        let to_ms = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|t| t.timestamp_millis())
                .unwrap_or(0)
        };
        Self {
            agent_id: sidecar.agent_id.clone(),
            parent_thread_id: sidecar.parent_thread_id.clone(),
            agent_type: sidecar.agent_type.clone(),
            name: sidecar.name.clone(),
            description: sidecar.description.clone(),
            status: sidecar.status,
            background: sidecar.background,
            started_at_ms: to_ms(&sidecar.created_at),
            ended_at_ms: sidecar.ended_at.as_deref().map(to_ms),
            result: sidecar.result.clone(),
            error: sidecar.error.clone(),
            usage: sidecar.usage.clone(),
            // Whatever report it owed was owed to a process that is gone.
            notified: true,
            runs: sidecar.runs,
            model: sidecar.model.clone(),
            context_tokens: sidecar.context_tokens,
        }
    }
}

/// One live agent. Mutable parts sit behind their own locks so a reader
/// snapshotting the list never waits on a writer appending a message.
pub struct TaskRecord {
    pub agent_id: String,
    pub parent_thread_id: String,
    pub agent_type: String,
    pub name: Option<String>,
    pub description: String,
    pub started_at_ms: i64,
    state: Mutex<TaskState>,
    /// Stops the current run. Replaced on resume.
    cancel: Mutex<CancellationToken>,
    /// Set once, by whichever path reports the finish first.
    notified: AtomicBool,
    /// Woken on every finish, for a `get_task_output` check that is waiting.
    finished: Notify,
    /// Woken when the parent sends this agent a message, for a
    /// `message_parent` call that is waiting for its answer.
    reply: Notify,
    /// A `message_parent` call is holding for the parent's answer right now.
    waiting_for_reply: AtomicBool,
    /// What it has been doing, from its live stream. See `activity`.
    activity: Mutex<super::activity::ActivityLog>,
    /// `providerId:modelKey` of the current run.
    model: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Default)]
struct TaskState {
    status: Option<TaskStatus>,
    ended_at_ms: Option<i64>,
    result: Option<String>,
    error: Option<String>,
    usage: SubagentUsage,
    runs: u32,
    /// Whether the CURRENT run reports through the parent conversation. A
    /// waiting parent gets the answer as its tool result; every resumed run
    /// is background and reports.
    background: bool,
    /// What the CURRENT run handed in with `submit_report`, if it has.
    submitted: Option<super::host::SubmittedReport>,
    /// Who stopped the CURRENT run, when someone did.
    stopped_by: Option<StopBy>,
}

/// Who stopped a run. The parent's report says so: a run the user stopped
/// must not be restarted or redone by the parent on its own initiative, and
/// before this the report read the same whoever pressed stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopBy {
    /// The person, from the Agents panel or the agent's tab.
    User,
    /// The parent agent, with `stop_agent`.
    Parent,
    /// The Agent Window closed with the agent still running.
    WindowClosed,
}

impl TaskRecord {
    #[must_use]
    pub fn new(
        agent_id: impl Into<String>,
        parent_thread_id: impl Into<String>,
        agent_type: impl Into<String>,
        name: Option<String>,
        description: impl Into<String>,
        background: bool,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            agent_id: agent_id.into(),
            parent_thread_id: parent_thread_id.into(),
            agent_type: agent_type.into(),
            name,
            description: description.into(),
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            state: Mutex::new(TaskState {
                status: Some(TaskStatus::Running),
                runs: 1,
                background,
                ..TaskState::default()
            }),
            cancel: Mutex::new(cancel),
            notified: AtomicBool::new(false),
            finished: Notify::new(),
            reply: Notify::new(),
            waiting_for_reply: AtomicBool::new(false),
            activity: Mutex::new(super::activity::ActivityLog::new()),
            model: Mutex::new(None),
        }
    }

    /// Fold one event from the child's live stream into its activity log.
    pub fn observe(&self, event: &crate::agent_runtime::events::AssistantEvent) {
        if let Ok(mut log) = self.activity.lock() {
            log.observe(event);
        }
    }

    /// What it has done since the previous check, marked seen.
    #[must_use]
    pub fn take_activity(&self) -> super::activity::CheckDigest {
        self.activity
            .lock()
            .map(|mut log| log.take_since_check())
            .unwrap_or_default()
    }

    /// The prompt size of its latest model call.
    #[must_use]
    pub fn context_tokens(&self) -> Option<u64> {
        self.activity.lock().ok().and_then(|log| log.context_tokens())
    }

    pub fn set_model(&self, pin: Option<String>) {
        if let Ok(mut slot) = self.model.lock() {
            *slot = pin;
        }
    }

    /// Does the current run report through the parent conversation?
    #[must_use]
    pub fn is_background(&self) -> bool {
        self.state.lock().map(|s| s.background).unwrap_or(false)
    }

    /// Hold the current run's report. Returns whether one was replaced.
    pub fn submit_report(&self, report: super::host::SubmittedReport) -> bool {
        self.state
            .lock()
            .map(|mut s| s.submitted.replace(report).is_some())
            .unwrap_or(false)
    }

    /// The current run's submitted report, if it has handed one in.
    #[must_use]
    pub fn submitted_report(&self) -> Option<super::host::SubmittedReport> {
        self.state.lock().ok().and_then(|s| s.submitted.clone())
    }

    /// A record rebuilt from an agent's files for one that finished in an
    /// earlier process — or was evicted — and is being resumed now.
    #[must_use]
    pub fn resumed_from_disk(
        sidecar: &super::store::AgentSidecar,
        cancel: CancellationToken,
    ) -> Self {
        let record = Self::new(
            sidecar.agent_id.clone(),
            sidecar.parent_thread_id.clone(),
            sidecar.agent_type.clone(),
            sidecar.name.clone(),
            sidecar.description.clone(),
            true,
            cancel,
        );
        if let Ok(mut state) = record.state.lock() {
            state.result = sidecar.result.clone();
            state.usage = sidecar.usage.clone();
            state.runs = sidecar.runs;
        }
        record.set_model(sidecar.model.clone());
        record
    }

    #[must_use]
    pub fn status(&self) -> TaskStatus {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.status)
            .unwrap_or(TaskStatus::Running)
    }

    #[must_use]
    pub fn is_running(&self) -> bool {
        self.status() == TaskStatus::Running
    }

    /// The token that stops the current run.
    #[must_use]
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel
            .lock()
            .map(|t| t.clone())
            .unwrap_or_else(|_| CancellationToken::new())
    }

    /// Who stopped the current run, if anyone did.
    #[must_use]
    pub fn stopped_by(&self) -> Option<StopBy> {
        self.state.lock().ok().and_then(|s| s.stopped_by)
    }

    /// What the run's stream has shown so far, counted. See
    /// [`super::activity::ActivityTotals`].
    #[must_use]
    pub fn activity_totals(&self) -> super::activity::ActivityTotals {
        self.activity
            .lock()
            .map(|log| log.totals())
            .unwrap_or_default()
    }

    /// The last `n` things it did, without marking them seen by a check.
    #[must_use]
    pub fn recent_activity(&self, n: usize) -> Vec<String> {
        self.activity
            .lock()
            .map(|log| log.recent(n))
            .unwrap_or_default()
    }

    /// Stop the current run on `by`'s behalf. Returns whether it was running.
    pub fn kill(&self, by: StopBy) -> bool {
        let was_running = self.is_running();
        if was_running {
            if let Ok(mut state) = self.state.lock() {
                // The first stop names who stopped it; a second press does
                // not rewrite that.
                state.stopped_by.get_or_insert(by);
            }
            self.cancel_token().cancel();
        }
        was_running
    }

    /// Record the end of a run. The result is the child's last message or
    /// the best partial answer; the error, when there is one, is kept beside
    /// it rather than replacing it — partial beats silent.
    pub fn finish(
        &self,
        status: TaskStatus,
        result: Option<String>,
        error: Option<String>,
        usage: SubagentUsage,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.status = Some(status);
            state.ended_at_ms = Some(chrono::Utc::now().timestamp_millis());
            if result.as_deref().is_some_and(|r| !r.trim().is_empty()) {
                state.result = result;
            }
            state.error = error;
            state.usage.add(&usage);
        }
        self.finished.notify_waiters();
    }

    /// Put a finished agent back to work under the same id, with a fresh
    /// cancel token. The old result stays readable until the new run ends.
    pub fn resume(&self, cancel: CancellationToken) {
        if let Ok(mut state) = self.state.lock() {
            state.status = Some(TaskStatus::Running);
            state.ended_at_ms = None;
            state.error = None;
            state.runs = state.runs.saturating_add(1);
            // Nobody is waiting on a resumed run's tool call; its answer
            // comes back through the conversation like any background run.
            state.background = true;
            // A new run owes a new report; the last one answered last time.
            state.submitted = None;
            state.stopped_by = None;
        }
        if let Ok(mut slot) = self.cancel.lock() {
            *slot = cancel;
        }
        // A resumed run finishes again, and that finish is a new report.
        self.notified.store(false, Ordering::SeqCst);
    }

    /// Wait until the current run ends, or `timeout` passes. `true` when
    /// it ended. Returns at once for an agent that is not running. Does not
    /// affect reporting: the finisher reports as usual.
    pub async fn wait_finished(&self, timeout: std::time::Duration) -> bool {
        if !self.is_running() {
            return true;
        }
        self.wait_finished_inner(timeout).await
    }

    /// The parent just sent this agent a message: wake a `message_parent`
    /// call that is waiting for it.
    pub fn notify_reply(&self) {
        self.reply.notify_waiters();
    }

    /// Is a `message_parent` call holding for the parent's answer?
    #[must_use]
    pub fn is_waiting_for_reply(&self) -> bool {
        self.waiting_for_reply.load(Ordering::SeqCst)
    }

    /// Hold until `take` finds the parent's answer, `timeout` passes, or
    /// `cancel` fires. `take` is asked once up front and again after every
    /// wake-up, with the wake-up armed BEFORE each ask, so an answer that lands
    /// between an ask and the wait is never missed. Marks the agent as waiting
    /// for the whole hold, so the parent can be told its message was taken at
    /// once.
    pub async fn wait_for_reply<F>(
        &self,
        timeout: std::time::Duration,
        cancel: &CancellationToken,
        mut take: F,
    ) -> Option<String>
    where
        F: FnMut() -> Option<String>,
    {
        struct Waiting<'a>(&'a AtomicBool);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        self.waiting_for_reply.store(true, Ordering::SeqCst);
        let _waiting = Waiting(&self.waiting_for_reply);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let woken = self.reply.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if let Some(answer) = take() {
                return Some(answer);
            }
            tokio::select! {
                _ = &mut woken => {}
                _ = tokio::time::sleep_until(deadline) => return take(),
                () = cancel.cancelled() => return None,
            }
        }
    }

    async fn wait_finished_inner(&self, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Arm the wakeup BEFORE re-checking, so a finish between the check
            // and the wait is not missed.
            let notified = self.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.is_running() {
                return true;
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => return !self.is_running(),
            }
        }
    }

    /// Claim the one completion report. `true` for exactly one caller per
    /// run; everyone after gets `false` and must stay silent.
    pub fn claim_notification(&self) -> bool {
        !self.notified.swap(true, Ordering::SeqCst)
    }

    #[must_use]
    pub fn was_notified(&self) -> bool {
        self.notified.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn snapshot(&self) -> TaskSnapshot {
        let state = self.state.lock().map(|s| s.clone()).unwrap_or_default();
        TaskSnapshot {
            agent_id: self.agent_id.clone(),
            parent_thread_id: self.parent_thread_id.clone(),
            agent_type: self.agent_type.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            status: state.status.unwrap_or(TaskStatus::Running),
            background: state.background,
            started_at_ms: self.started_at_ms,
            ended_at_ms: state.ended_at_ms,
            result: state.result,
            error: state.error,
            usage: state.usage,
            notified: self.was_notified(),
            runs: state.runs,
            model: self.model.lock().ok().and_then(|m| m.clone()),
            context_tokens: self.context_tokens(),
        }
    }
}

/// Every agent this process knows about, by id, plus the parent's names for
/// them.
#[derive(Default)]
pub struct TaskRegistry {
    records: DashMap<String, Arc<TaskRecord>>,
    /// `(parent thread id, name)` → agent id. A name is the parent's handle;
    /// two parents may each have a `tests` agent.
    names: DashMap<(String, String), String>,
}

impl TaskRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, record: Arc<TaskRecord>) {
        if let Some(name) = record.name.as_deref() {
            self.names.insert(
                (record.parent_thread_id.clone(), name.to_string()),
                record.agent_id.clone(),
            );
        }
        self.records.insert(record.agent_id.clone(), record);
    }

    #[must_use]
    pub fn get(&self, agent_id: &str) -> Option<Arc<TaskRecord>> {
        self.records.get(agent_id).map(|r| r.value().clone())
    }

    /// Resolve `to` the way the contract says: a name registered by this
    /// parent first, then a raw agent id.
    #[must_use]
    pub fn resolve(&self, parent_thread_id: &str, to: &str) -> Option<Arc<TaskRecord>> {
        let to = to.trim();
        if let Some(id) = self
            .names
            .get(&(parent_thread_id.to_string(), to.to_string()))
        {
            if let Some(record) = self.get(id.value()) {
                return Some(record);
            }
        }
        self.get(to)
    }

    /// Every agent a parent started, newest first.
    #[must_use]
    pub fn for_parent(&self, parent_thread_id: &str) -> Vec<Arc<TaskRecord>> {
        let mut records: Vec<Arc<TaskRecord>> = self
            .records
            .iter()
            .filter(|r| r.value().parent_thread_id == parent_thread_id)
            .map(|r| r.value().clone())
            .collect();
        records.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        records
    }

    /// Every running agent, for a stop-everything on app exit.
    #[must_use]
    pub fn running(&self) -> Vec<Arc<TaskRecord>> {
        self.records
            .iter()
            .filter(|r| r.value().is_running())
            .map(|r| r.value().clone())
            .collect()
    }

    /// Stop every running agent. Returns how many were running.
    pub fn kill_all(&self) -> usize {
        self.running()
            .iter()
            .filter(|r| r.kill(StopBy::WindowClosed))
            .count()
    }

    /// Forget a finished agent's live record. Its files are untouched — this
    /// is the eviction the contract allows, and it must never reach disk.
    pub fn evict(&self, agent_id: &str) -> bool {
        let Some((_, record)) = self.records.remove(agent_id) else {
            return false;
        };
        if let Some(name) = record.name.as_deref() {
            self.names
                .remove(&(record.parent_thread_id.clone(), name.to_string()));
        }
        true
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.records.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, name: Option<&str>) -> Arc<TaskRecord> {
        Arc::new(TaskRecord::new(
            id,
            "parent-1",
            "general-purpose",
            name.map(str::to_string),
            "Do a thing",
            false,
            CancellationToken::new(),
        ))
    }

    #[test]
    fn notification_is_claimed_exactly_once_per_run() {
        let r = record("agent_a", None);
        assert!(r.claim_notification());
        assert!(!r.claim_notification());
        assert!(!r.claim_notification());
        r.resume(CancellationToken::new());
        assert!(r.claim_notification(), "a resumed run reports again");
        assert!(!r.claim_notification());
    }

    #[test]
    fn finish_keeps_a_result_beside_an_error_and_sums_usage() {
        let r = record("agent_a", None);
        let usage = SubagentUsage {
            input_tokens: 10,
            output_tokens: 5,
            tool_calls: 2,
            iterations: 1,
            duration_ms: 100,
        };
        r.finish(TaskStatus::Failed, Some("got this far".into()), Some("boom".into()), usage.clone());
        let snap = r.snapshot();
        assert_eq!(snap.status, TaskStatus::Failed);
        assert_eq!(snap.result.as_deref(), Some("got this far"));
        assert_eq!(snap.error.as_deref(), Some("boom"));
        assert_eq!(snap.usage.input_tokens, 10);
        // A blank result never overwrites a real one.
        r.finish(TaskStatus::Completed, Some("   ".into()), None, usage);
        let snap = r.snapshot();
        assert_eq!(snap.result.as_deref(), Some("got this far"));
        assert_eq!(snap.usage.input_tokens, 20, "usage accumulates across runs");
        assert!(snap.error.is_none());
    }

    #[tokio::test]
    async fn a_waiting_question_ends_on_the_answer_the_time_limit_or_a_stop() {
        use std::sync::atomic::AtomicUsize;
        let r = Arc::new(record("agent_q", None));
        let short = std::time::Duration::from_millis(60);

        // The answer lands while it holds: woken, taken, flag cleared.
        let answer: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        let waiter = {
            let r = r.clone();
            let answer = answer.clone();
            tokio::spawn(async move {
                r.wait_for_reply(std::time::Duration::from_secs(5), &CancellationToken::new(), || {
                    answer.lock().unwrap().take()
                })
                .await
            })
        };
        for _ in 0..100 {
            if r.is_waiting_for_reply() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(r.is_waiting_for_reply());
        *answer.lock().unwrap() = Some("skip it".into());
        r.notify_reply();
        assert_eq!(waiter.await.unwrap().as_deref(), Some("skip it"));
        assert!(!r.is_waiting_for_reply(), "the flag clears when the hold ends");

        // Nothing comes: the time limit ends it, asking once more at the end.
        let asks = AtomicUsize::new(0);
        let none = r
            .wait_for_reply(short, &CancellationToken::new(), || {
                asks.fetch_add(1, Ordering::SeqCst);
                None
            })
            .await;
        assert!(none.is_none());
        assert!(asks.load(Ordering::SeqCst) >= 2, "asked up front and at the deadline");

        // A stop ends it at once.
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        assert!(r
            .wait_for_reply(std::time::Duration::from_secs(5), &cancel, || None)
            .await
            .is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(!r.is_waiting_for_reply());
    }

    #[tokio::test]
    async fn wait_finished_wakes_on_finish_and_times_out_otherwise() {
        let r = record("agent_a", None);
        assert!(
            !r.wait_finished(std::time::Duration::from_millis(30)).await,
            "still running after the timeout"
        );
        let waiter = {
            let r = r.clone();
            tokio::spawn(async move { r.wait_finished(std::time::Duration::from_secs(5)).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        r.finish(TaskStatus::Completed, Some("ok".into()), None, SubagentUsage::default());
        assert!(waiter.await.unwrap(), "the waiter is woken by the finish");
        assert!(r.wait_finished(std::time::Duration::ZERO).await, "finished returns at once");
        assert_eq!(r.snapshot().runs, 1);
        r.resume(CancellationToken::new());
        assert_eq!(r.snapshot().runs, 2);
    }

    #[test]
    fn names_resolve_per_parent_then_fall_back_to_ids() {
        let reg = TaskRegistry::new();
        reg.insert(record("agent_a", Some("tests")));
        let other = Arc::new(TaskRecord::new(
            "agent_b",
            "parent-2",
            "explore",
            Some("tests".to_string()),
            "Other parent's agent",
            true,
            CancellationToken::new(),
        ));
        reg.insert(other);
        assert_eq!(reg.resolve("parent-1", "tests").unwrap().agent_id, "agent_a");
        assert_eq!(reg.resolve("parent-2", "tests").unwrap().agent_id, "agent_b");
        assert_eq!(reg.resolve("parent-1", "agent_b").unwrap().agent_id, "agent_b");
        assert!(reg.resolve("parent-1", "nobody").is_none());
        assert_eq!(reg.for_parent("parent-1").len(), 1);
    }

    #[test]
    fn kill_cancels_a_running_agent_and_evict_forgets_the_name() {
        let reg = TaskRegistry::new();
        let r = record("agent_a", Some("tests"));
        let token = r.cancel_token();
        reg.insert(r.clone());
        assert!(r.kill(StopBy::User));
        assert!(token.is_cancelled());
        assert_eq!(r.stopped_by(), Some(StopBy::User));
        r.finish(TaskStatus::Killed, None, None, SubagentUsage::default());
        assert!(!r.kill(StopBy::Parent), "a finished agent is not killed twice");
        assert_eq!(r.stopped_by(), Some(StopBy::User), "the first stop is the one named");
        r.resume(CancellationToken::new());
        assert_eq!(r.stopped_by(), None, "a resumed run starts unstopped");
        assert!(reg.evict("agent_a"));
        assert!(reg.resolve("parent-1", "tests").is_none());
        assert!(!reg.evict("agent_a"));
    }
}
